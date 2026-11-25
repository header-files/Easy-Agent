import { createHash, randomUUID } from 'node:crypto';
import { ApprovalError } from './errors.ts';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalStatus,
} from './types.ts';

export interface RequireApprovalInput {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  executionId: string;
  workspaceId?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface Pending {
  request: ApprovalRequest;
  resolve: () => void;
  reject: (error: ApprovalError) => void;
  timer?: ReturnType<typeof setTimeout>;
  onAbort?: () => void;
}

export type ApprovalListener = (request: ApprovalRequest) => void;

/** In-process approvals; decisions arrive via Application / CLI, not Runtime stdin. */
export class ApprovalService {
  private readonly pending = new Map<string, Pending>();
  private readonly history = new Map<string, ApprovalRequest>();
  private readonly listeners = new Set<ApprovalListener>();
  private channelOpen = true;

  setChannelOpen(open: boolean): void {
    this.channelOpen = open;
  }

  /** True when at least one decision listener is registered. */
  hasDecisionChannel(): boolean {
    return this.channelOpen && this.listeners.size > 0;
  }

  subscribe(listener: ApprovalListener): () => void {
    this.listeners.add(listener);
    // Replay in-flight requests so CLI can subscribe slightly after submit.
    for (const entry of this.pending.values()) {
      try {
        listener(entry.request);
      } catch {
        /* Listeners must not break approval flow. */
      }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  listPending(): readonly ApprovalRequest[] {
    return [...this.pending.values()].map((item) => item.request);
  }

  get(id: string): ApprovalRequest | undefined {
    return this.pending.get(id)?.request ?? this.history.get(id);
  }

  async require(input: RequireApprovalInput): Promise<ApprovalRequest> {
    if (!this.channelOpen) throw new ApprovalError('unavailable');
    if (
      typeof input.toolCallId !== 'string' ||
      input.toolCallId.length === 0 ||
      typeof input.toolName !== 'string' ||
      input.toolName.length === 0 ||
      typeof input.executionId !== 'string' ||
      input.executionId.length === 0 ||
      typeof input.args !== 'object' ||
      input.args === null ||
      Array.isArray(input.args)
    ) {
      throw new ApprovalError('invalid_request');
    }
    if (input.signal?.aborted) throw new ApprovalError('cancelled');
    // Fail closed: without a decision listener the request would hang or be invisible.
    if (this.listeners.size === 0) {
      throw new ApprovalError('unavailable');
    }
    if (
      input.timeoutMs !== undefined &&
      (typeof input.timeoutMs !== 'number' ||
        !Number.isSafeInteger(input.timeoutMs) ||
        input.timeoutMs <= 0)
    ) {
      throw new ApprovalError('invalid_request');
    }

    const id = randomUUID();
    // Deep clone + deep freeze so listeners cannot mutate nested values before decide.
    const frozenArgs = deepFreeze(structuredClone(input.args)) as Record<
      string,
      unknown
    >;
    const request: ApprovalRequest = Object.freeze({
      id,
      executionId: input.executionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      arguments: frozenArgs,
      argumentsHash: hashArgs(frozenArgs),
      ...(input.workspaceId === undefined
        ? {}
        : { workspaceId: input.workspaceId }),
      status: 'PENDING' as const,
      createdAt: new Date().toISOString(),
    });

    await new Promise<void>((resolve, reject) => {
      const entry: Pending = {
        request,
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      const cleanup = () => {
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.onAbort && input.signal) {
          input.signal.removeEventListener('abort', entry.onAbort);
        }
      };
      if (input.timeoutMs !== undefined) {
        entry.timer = setTimeout(() => {
          this.finalize(id, 'EXPIRED', new ApprovalError('expired'));
        }, input.timeoutMs);
      }
      entry.onAbort = () => {
        this.finalize(id, 'CANCELLED', new ApprovalError('cancelled'));
      };
      input.signal?.addEventListener('abort', entry.onAbort, { once: true });
      this.pending.set(id, entry);
      this.emit(request);
    });

    const finished = this.history.get(id);
    if (!finished || finished.status !== 'APPROVED') {
      throw new ApprovalError('not_pending');
    }
    return finished;
  }

  decide(id: string, decision: ApprovalDecision): ApprovalRequest {
    if (decision !== 'approve' && decision !== 'reject') {
      throw new ApprovalError('invalid_request');
    }
    const entry = this.pending.get(id);
    if (!entry) {
      if (this.history.has(id)) throw new ApprovalError('not_pending');
      throw new ApprovalError('not_found');
    }
    if (decision === 'approve') {
      this.finalize(id, 'APPROVED');
    } else {
      this.finalize(id, 'REJECTED', new ApprovalError('rejected'));
    }
    return this.history.get(id)!;
  }

  cancel(id: string): boolean {
    if (!this.pending.has(id)) return false;
    this.finalize(id, 'CANCELLED', new ApprovalError('cancelled'));
    return true;
  }

  private finalize(
    id: string,
    status: Exclude<ApprovalStatus, 'PENDING'>,
    error?: ApprovalError,
  ): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    const finished: ApprovalRequest = Object.freeze({
      ...entry.request,
      status,
    });
    this.history.set(id, finished);
    this.emit(finished);
    if (error) entry.reject(error);
    else entry.resolve();
  }

  private emit(request: ApprovalRequest): void {
    for (const listener of this.listeners) {
      try {
        listener(request);
      } catch {
        /* Listeners must not break approval flow. */
      }
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const key of Reflect.ownKeys(value as object)) {
      const record = value as Record<string | symbol, unknown>;
      deepFreeze(record[key]);
    }
  }
  return Object.freeze(value);
}

function hashArgs(args: Record<string, unknown>): string {
  return createHash('sha256')
    .update(stableStringify(args))
    .digest('hex')
    .slice(0, 32);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}
