import type {
  SessionAgent,
  SessionExecution,
  SessionSubmitOptions,
  SessionSummary,
} from '../harness/contracts/agent/index.ts';
import type {
  AgentLoop,
  AgentLoopContext,
} from '../harness/contracts/agent-loop/index.ts';
import type {
  ExecutionEngine,
  ExecutionEvent,
  ExecutionResult,
} from '../harness/contracts/execution/index.ts';
import type { Logger } from '../runtime/logging/index.ts';
import {
  isDurableCommittedFailure,
  type PersistenceBridge,
} from '../runtime/persistence/index.ts';
import {
  configSnapshot,
  invalidInput,
  resolveConfig,
} from './session-config.ts';
import {
  contextSnapshot,
  EngineEvents,
  internalFailure,
} from './session-protocol.ts';
import { SessionEventBuffer } from './session-event-buffer.ts';
import { snapshot } from './snapshots.ts';

interface SessionOptions {
  context?: AgentLoopContext['context'];
  config?: AgentLoopContext['config'];
  workspaceId?: string;
  eventBufferCapacity: number;
  executionId: () => string;
  logger?: Logger;
  persistence?: PersistenceBridge;
  /** When restoring from Event Log, skip session/created persist. */
  restored?: boolean;
}
interface Submission {
  id: string;
  input: string;
  config: AgentLoopContext['config'];
  controller: AbortController;
  buffer: SessionEventBuffer;
  settle: (result: ExecutionResult) => void;
  state: 'PENDING_PERSIST' | 'QUEUED' | 'RUNNING' | 'SETTLED';
  /** Set when cancel arrives before durable create finishes. */
  cancelRequested: boolean;
}

/** Session-owned scheduling, independent from whether any observer consumes events. */
export class DefaultSessionAgent implements SessionAgent {
  private readonly id: string;
  private readonly engine: ExecutionEngine;
  private readonly loop: AgentLoop;
  private readonly options: SessionOptions;
  private readonly createdAt = new Date().toISOString();
  private committed: AgentLoopContext['context'];
  private defaults: NonNullable<SessionSubmitOptions['config']>;
  private queue: Submission[] = [];
  private readonly submissions = new Map<string, Submission>();
  private active: Submission | undefined;
  /** >0 while terminal facts are being persisted (active may already be cleared). */
  private durableSettling = 0;
  private pumping = false;
  private closed = false;
  private readonly workspaceId: string | undefined;
  private readonly persistence: PersistenceBridge | undefined;
  private createdPersisted: boolean;
  private pendingPersist: Promise<void> = Promise.resolve();

  constructor(
    sessionId: string,
    engine: ExecutionEngine,
    loop: AgentLoop,
    options: SessionOptions,
  ) {
    this.id = sessionId;
    this.engine = engine;
    this.loop = loop;
    this.workspaceId = options.workspaceId;
    this.persistence = options.persistence;
    this.createdPersisted = options.restored === true;
    this.options = {
      eventBufferCapacity: options.eventBufferCapacity,
      executionId: options.executionId,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
      ...(options.workspaceId === undefined
        ? {}
        : { workspaceId: options.workspaceId }),
      ...(options.persistence === undefined
        ? {}
        : { persistence: options.persistence }),
      ...(options.restored === undefined ? {} : { restored: options.restored }),
    };
    this.committed = contextSnapshot(
      options.context === undefined ? { messages: [] } : options.context,
    );
    this.defaults = configSnapshot(options.config, false);
  }

  private trackPersist(work: Promise<void>): void {
    this.pendingPersist = this.pendingPersist.then(() => work).catch(() => {});
  }

  /**
   * Commit session/created before Application confirms creation.
   * Restored sessions no-op. Fail closed: closes the session on persist failure.
   */
  async ensureCreated(): Promise<void> {
    if (!this.persistence || this.createdPersisted) return;
    await this.persistCreated();
    if (!this.createdPersisted) {
      throw new Error('Session creation was not durably committed.');
    }
  }

  private async persistCreated(): Promise<void> {
    if (!this.persistence || this.createdPersisted) return;
    try {
      await this.persistence.requireSessionEvents(this.id, [
        {
          type: 'session/created',
          payload: {
            ...(this.defaults.model?.name === undefined
              ? {}
              : { model: this.defaults.model.name }),
            ...(this.defaults.model?.parameters === undefined
              ? {}
              : { modelParameters: this.defaults.model.parameters }),
            ...(this.defaults.tools?.allowedNames === undefined
              ? {}
              : { allowedNames: this.defaults.tools.allowedNames }),
            ...(this.defaults.extensions === undefined
              ? {}
              : { extensions: this.defaults.extensions }),
            context: contextSnapshot(this.committed),
            ...(this.workspaceId === undefined
              ? {}
              : { workspaceId: this.workspaceId }),
          },
        },
      ]);
      this.createdPersisted = true;
    } catch (error) {
      if (isDurableCommittedFailure(error)) {
        // Journal committed; keep creation even if projection refresh failed.
        this.createdPersisted = true;
        return;
      }
      this.closed = true;
      this.diagnostic();
      throw new Error('Session creation persistence failed.', { cause: error });
    }
  }
  get sessionId(): string {
    return this.id;
  }
  getContext(): AgentLoopContext['context'] {
    return contextSnapshot(this.committed);
  }
  getModel(): string | undefined {
    return this.defaults.model?.name;
  }
  getWorkspaceId(): string | undefined {
    return this.workspaceId;
  }
  async setModel(modelId: string): Promise<void> {
    if (this.closed || typeof modelId !== 'string' || !modelId.trim()) {
      return invalidInput();
    }
    if (!this.persistence) {
      this.defaults = configSnapshot(
        resolveConfig(this.defaults, { model: { name: modelId } }),
        true,
      );
      return;
    }
    await this.pendingPersist;
    if (!this.createdPersisted) await this.persistCreated();
    try {
      await this.persistence.requireSessionEvents(this.id, [
        {
          type: 'session/model_changed',
          payload: { model: modelId },
        },
      ]);
    } catch (error) {
      if (!isDurableCommittedFailure(error)) throw error;
    }
    // Memory change only after durable commit (including commit+refresh-fail).
    this.defaults = configSnapshot(
      resolveConfig(this.defaults, { model: { name: modelId } }),
      true,
    );
  }

  /** Wait for outstanding Session Event Log commits (tests / shutdown). */
  async flushPersistence(): Promise<void> {
    await this.pendingPersist;
  }

  /** @internal Manager lifecycle, not part of the Harness SessionAgent contract. */
  summary(): SessionSummary {
    return {
      sessionId: this.id,
      createdAt: this.createdAt,
      queuedCount: this.queue.length,
      ...(this.active === undefined
        ? {}
        : { runningExecutionId: this.active.id }),
    };
  }
  /** @internal Manager lifecycle, atomically refuse deletion while work is owned. */
  closeIfIdle(): boolean {
    // Already closed (including delete-uncertain) is not a fresh idle close.
    if (this.closed) return false;
    if (this.active || this.durableSettling > 0 || this.queue.length)
      return false;
    for (const submission of this.submissions.values()) {
      // PENDING_PERSIST owns work before it enters the queue.
      if (submission.state === 'PENDING_PERSIST') return false;
    }
    this.closed = true;
    return true;
  }

  /**
   * @internal Re-open after a failed durable delete so the Session stays managed.
   * Only valid when closeIfIdle() just closed an idle Session and delete persist failed.
   */
  reviveAfterFailedDelete(): void {
    if (!this.closed) return;
    if (this.active || this.queue.length) return;
    for (const submission of this.submissions.values()) {
      if (submission.state !== 'SETTLED') return;
    }
    this.closed = false;
  }

  submit(input: string, options?: SessionSubmitOptions): SessionExecution {
    if (this.closed) throw new Error('Session is closed.');
    if (
      typeof input !== 'string' ||
      (options !== undefined &&
        (typeof options !== 'object' ||
          options === null ||
          Array.isArray(options)))
    )
      return invalidInput();
    const overrides = configSnapshot(options?.config, true);
    // Freeze all effective options now; later Session model switches cannot rewrite queued work.
    const config = resolveConfig(this.defaults, overrides);
    const id = this.options.executionId();
    const buffer = new SessionEventBuffer(this.options.eventBufferCapacity);
    let settle!: (result: ExecutionResult) => void;
    const result = new Promise<ExecutionResult>((resolve) => {
      settle = resolve;
    });
    const submission: Submission = {
      id,
      input,
      config,
      controller: new AbortController(),
      buffer,
      settle,
      state: this.persistence ? 'PENDING_PERSIST' : 'QUEUED',
      cancelRequested: false,
    };
    this.submissions.set(id, submission);
    if (!this.persistence) {
      this.queue.push(submission);
      this.schedule();
    } else {
      void this.persistThenQueue(submission);
    }
    return Object.freeze({ executionId: id, events: buffer.events, result });
  }

  private queuedCancelResult(): ExecutionResult {
    return {
      status: 'CANCELLED',
      reason: 'cancelled_while_queued',
    };
  }

  private async persistThenQueue(submission: Submission): Promise<void> {
    if (!this.persistence) return;
    const abortIfCancelled = (): boolean => {
      if (
        !submission.cancelRequested &&
        submission.state === 'PENDING_PERSIST'
      ) {
        return false;
      }
      if (submission.state !== 'SETTLED') {
        this.finishSettlement(
          submission,
          this.queuedCancelResult(),
          this.queuedCancelResult(),
        );
      }
      return true;
    };
    try {
      await this.pendingPersist;
      if (abortIfCancelled()) return;
      if (!this.createdPersisted) await this.persistCreated();
      if (this.closed) {
        this.finishSettlement(submission, internalFailure(), internalFailure());
        return;
      }
      if (abortIfCancelled()) return;
      await this.persistence.requireSessionEvents(this.id, [
        {
          type: 'user/message',
          payload: { content: submission.input },
          executionId: submission.id,
        },
        {
          type: 'execution/created',
          payload: {
            executionId: submission.id,
            input: submission.input,
            ...(submission.config.model?.name === undefined
              ? {}
              : { model: submission.config.model.name }),
            ...(submission.config.tools?.allowedNames === undefined
              ? {}
              : { allowedNames: submission.config.tools.allowedNames }),
          },
          executionId: submission.id,
        },
      ]);
      if (submission.cancelRequested || this.closed) {
        // Create facts already committed — record a durable cancel terminal.
        await this.settleDurable(submission, this.queuedCancelResult());
        return;
      }
      if (submission.state !== 'PENDING_PERSIST') return;
      submission.state = 'QUEUED';
      this.queue.push(submission);
      this.schedule();
    } catch (error) {
      if (submission.state === 'SETTLED') return;
      if (isDurableCommittedFailure(error)) {
        // execution/created is on disk; must write a terminal (cancel or fail).
        const terminal = submission.cancelRequested
          ? this.queuedCancelResult()
          : internalFailure();
        try {
          await this.settleDurable(submission, terminal);
        } catch {
          this.finishSettlement(submission, terminal, terminal);
        }
        return;
      }
      if (submission.cancelRequested) {
        this.finishSettlement(
          submission,
          this.queuedCancelResult(),
          this.queuedCancelResult(),
        );
        return;
      }
      this.finishSettlement(submission, internalFailure(), internalFailure());
    }
  }

  cancel(executionId: string): boolean {
    const submission = this.submissions.get(executionId);
    if (!submission || submission.state === 'SETTLED') return false;
    if (submission.state === 'PENDING_PERSIST') {
      // Do not settle yet — persistThenQueue must observe cancel and skip/create+cancel.
      submission.cancelRequested = true;
      this.queue = this.queue.filter((item) => item !== submission);
      return true;
    }
    if (submission.state === 'QUEUED') {
      this.queue = this.queue.filter((item) => item !== submission);
      if (!this.persistence) {
        this.finishSettlement(
          submission,
          this.queuedCancelResult(),
          this.queuedCancelResult(),
        );
      } else {
        void this.settleDurable(submission, this.queuedCancelResult());
      }
    } else {
      submission.controller.abort();
      this.cancelEngine(submission.id);
    }
    return true;
  }

  private diagnostic(): void {
    try {
      const result: unknown = this.options.logger?.warn(
        'Session execution driver failed.',
        { code: 'internal_error' },
      );
      if (result !== undefined) void Promise.resolve(result).catch(() => {});
    } catch {
      /* Best effort. */
    }
  }
  private cancelEngine(id: string): void {
    try {
      this.engine.cancel(id);
    } catch {
      this.diagnostic();
    }
  }
  private schedule(): void {
    if (this.pumping) return;
    this.pumping = true;
    void Promise.resolve()
      .then(() => this.pump())
      .catch(() => {
        this.diagnostic();
      })
      .finally(() => {
        this.pumping = false;
        if (this.queue.length) this.schedule();
      });
  }

  /**
   * Persist terminal facts first; only then update committed history and resolve
   * the public result. Persist failure never claims durable COMPLETED.
   */
  private async settleDurable(
    submission: Submission,
    result: ExecutionResult,
  ): Promise<void> {
    if (submission.state === 'SETTLED') return;
    this.durableSettling += 1;
    try {
      let prepared: ExecutionResult;
      try {
        prepared = snapshot(result);
      } catch {
        prepared = internalFailure();
        this.diagnostic();
      }

      if (this.persistence) {
        try {
          await this.persistSettled(submission.id, prepared);
        } catch (error) {
          if (isDurableCommittedFailure(error)) {
            // Terminal event COMMITTED; resolve intended result despite stale projection.
            this.active = undefined;
            this.finishSettlement(submission, prepared, prepared);
            return;
          }
          this.diagnostic();
          // Do not update Message history or claim a durable terminal success/failure.
          this.active = undefined;
          this.finishSettlement(submission, prepared, internalFailure());
          return;
        }
      }

      // Clear active before resolving result so awaiters see an idle slot,
      // while durableSettling still blocks delete until this function exits.
      this.active = undefined;
      this.finishSettlement(submission, prepared, prepared);
    } finally {
      this.durableSettling -= 1;
      this.active = undefined;
    }
  }

  private finishSettlement(
    submission: Submission,
    source: ExecutionResult,
    publicResult: ExecutionResult,
  ): void {
    if (submission.state === 'SETTLED') return;
    try {
      if (
        publicResult.status === 'COMPLETED' &&
        source.status === 'COMPLETED' &&
        source.loopResult.updatedContext !== undefined
      ) {
        this.committed = contextSnapshot(source.loopResult.updatedContext);
      }
    } catch {
      publicResult = internalFailure();
      this.diagnostic();
    }
    submission.state = 'SETTLED';
    this.submissions.delete(submission.id);
    submission.buffer.finish();
    submission.settle(publicResult);
  }

  /** Exposed for cold-start restore of Message Projection into live context. */
  replaceCommittedContext(context: AgentLoopContext['context']): void {
    this.committed = contextSnapshot(context);
  }

  private async persistSettled(
    executionId: string,
    result: ExecutionResult,
  ): Promise<void> {
    if (!this.persistence) return;
    if (result.status === 'COMPLETED') {
      const updated = result.loopResult.updatedContext;
      await this.persistence.requireSessionEvents(this.id, [
        {
          type: 'execution/completed',
          payload: {
            executionId,
            result: {
              status: 'COMPLETED',
              output:
                result.loopResult.status === 'completed'
                  ? result.loopResult.output
                  : undefined,
            },
            // Phase 1: updatedContext is an authoritative full snapshot, not a delta.
            ...(updated === undefined
              ? {}
              : { context: contextSnapshot(updated) }),
          },
          executionId,
        },
      ]);
      return;
    }
    if (result.status === 'CANCELLED') {
      await this.persistence.requireSessionEvents(this.id, [
        {
          type: 'execution/cancelled',
          payload: {
            executionId,
            reason:
              'reason' in result && typeof result.reason === 'string'
                ? result.reason
                : 'cancelled',
          },
          executionId,
        },
      ]);
      return;
    }
    await this.persistence.requireSessionEvents(this.id, [
      {
        type: 'execution/failed',
        payload: {
          executionId,
          error: {
            code:
              result.status === 'FAILED' && 'error' in result
                ? result.error.code
                : 'internal_error',
          },
        },
        executionId,
      },
    ]);
  }

  private async pump(): Promise<void> {
    while (this.queue.length) {
      const submission = this.queue.shift()!;
      if (submission.state !== 'QUEUED') continue;
      this.active = submission;
      submission.state = 'RUNNING';
      if (this.persistence) {
        try {
          await this.persistence.requireSessionEvents(this.id, [
            {
              type: 'execution/started',
              payload: { executionId: submission.id },
              executionId: submission.id,
            },
          ]);
        } catch {
          await this.settleDurable(submission, internalFailure());
          this.active = undefined;
          continue;
        }
      }
      try {
        const outcome = await this.drive(submission);
        // Keep active through terminal persist so closeIfIdle cannot race settle.
        await this.settleDurable(submission, outcome);
      } catch {
        this.diagnostic();
        await this.settleDurable(submission, internalFailure());
      } finally {
        this.active = undefined;
      }
    }
  }

  private async drive(submission: Submission): Promise<ExecutionResult> {
    let iterator: AsyncIterator<ExecutionEvent> | undefined;
    let done = false;
    try {
      const context: AgentLoopContext = {
        input: { content: submission.input },
        context: this.getContext(),
        config: snapshot(submission.config),
        control: { signal: submission.controller.signal },
        metadata: {
          sessionId: this.id,
          executionId: submission.id,
          ...(this.workspaceId === undefined
            ? {}
            : { workspaceId: this.workspaceId }),
        },
      };
      const iterable = this.engine.execute({
        executionId: submission.id,
        loop: this.loop,
        context,
      });
      iterator = iterable[Symbol.asyncIterator]();
      const protocol = new EngineEvents(submission.id);
      while (true) {
        const step = await iterator.next();
        if (!step || typeof step !== 'object') return invalidInput();
        const completed = step.done;
        if (completed !== undefined && typeof completed !== 'boolean')
          return invalidInput();
        if (completed) {
          done = true;
          break;
        }
        submission.buffer.publish(protocol.accept(step.value));
      }
      return protocol.result();
    } catch {
      submission.controller.abort();
      this.cancelEngine(submission.id);
      this.diagnostic();
      return internalFailure();
    } finally {
      if (!done && iterator) {
        try {
          const close = iterator.return;
          let step = close ? await close.call(iterator) : await iterator.next();
          while (!step.done) step = await iterator.next();
        } catch {
          this.diagnostic();
        }
      }
    }
  }
}
