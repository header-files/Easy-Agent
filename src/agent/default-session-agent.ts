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
  eventBufferCapacity: number;
  executionId: () => string;
  logger?: Logger;
}
interface Submission {
  id: string;
  input: string;
  config: AgentLoopContext['config'];
  controller: AbortController;
  buffer: SessionEventBuffer;
  settle: (result: ExecutionResult) => void;
  state: 'QUEUED' | 'RUNNING' | 'SETTLED';
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
  private pumping = false;
  private closed = false;

  constructor(
    sessionId: string,
    engine: ExecutionEngine,
    loop: AgentLoop,
    options: SessionOptions,
  ) {
    this.id = sessionId;
    this.engine = engine;
    this.loop = loop;
    this.options = {
      eventBufferCapacity: options.eventBufferCapacity,
      executionId: options.executionId,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    };
    this.committed = contextSnapshot(
      options.context === undefined ? { messages: [] } : options.context,
    );
    this.defaults = configSnapshot(options.config, false);
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
  setModel(modelId: string): void {
    if (this.closed || typeof modelId !== 'string' || !modelId.trim()) {
      return invalidInput();
    }
    this.defaults = configSnapshot(
      resolveConfig(this.defaults, { model: { name: modelId } }),
      true,
    );
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
    if (this.active || this.queue.length) return false;
    this.closed = true;
    return true;
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
      state: 'QUEUED',
    };
    this.submissions.set(id, submission);
    this.queue.push(submission);
    this.schedule();
    return Object.freeze({ executionId: id, events: buffer.events, result });
  }

  cancel(executionId: string): boolean {
    const submission = this.submissions.get(executionId);
    if (!submission || submission.state === 'SETTLED') return false;
    if (submission.state === 'QUEUED') {
      this.queue = this.queue.filter((item) => item !== submission);
      this.settle(submission, {
        status: 'CANCELLED',
        reason: 'cancelled_while_queued',
      });
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

  private settle(submission: Submission, result: ExecutionResult): void {
    if (submission.state === 'SETTLED') return;
    let publicResult: ExecutionResult;
    try {
      if (
        result.status === 'COMPLETED' &&
        result.loopResult.updatedContext !== undefined
      ) {
        const next = contextSnapshot(result.loopResult.updatedContext);
        publicResult = snapshot(result);
        this.committed = next;
      } else publicResult = snapshot(result);
    } catch {
      publicResult = internalFailure();
      this.diagnostic();
    }
    submission.state = 'SETTLED';
    this.submissions.delete(submission.id);
    submission.buffer.finish();
    submission.settle(publicResult);
  }

  private async pump(): Promise<void> {
    while (this.queue.length) {
      const submission = this.queue.shift()!;
      if (submission.state !== 'QUEUED') continue;
      this.active = submission;
      submission.state = 'RUNNING';
      try {
        this.settle(submission, await this.drive(submission));
      } catch {
        this.diagnostic();
        this.settle(submission, internalFailure());
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
        metadata: { sessionId: this.id, executionId: submission.id },
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
