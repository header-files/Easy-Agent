import type {
  AgentLoopEvent,
  AgentLoopResult,
} from '../../harness/contracts/agent-loop/index.ts';
import type {
  ExecutionEngine,
  ExecutionEvent,
  ExecutionRequest,
  ExecutionResult,
  ExecutionSnapshot,
} from '../../harness/contracts/execution/index.ts';
import { createLogger, type Logger } from '../../runtime/logging/index.ts';
import {
  LoopProtocol,
  prepare,
  ProtocolError,
  isProtocolError,
} from './protocol.ts';
import { snapshot } from './snapshots.ts';

export interface DefaultExecutionEngineOptions {
  maxRetainedSnapshots?: number;
  logger?: Logger;
}
interface Consumption {
  active?: Active;
  consumerClosed: boolean;
}
interface Active {
  controller: AbortController;
  cancelRequested: boolean;
  finalized: boolean;
  external: AbortSignal;
  onAbort: () => void;
  started: number;
  snapshot: ExecutionSnapshot;
  cancelWaiter?: () => void;
  iterator?: AsyncIterator<AgentLoopEvent>;
  loopDone: boolean;
  pendingNext?: Promise<IteratorResult<AgentLoopEvent>>;
  cleanup?: Promise<void>;
}

function failed(
  code:
    'loop_stopped' | 'loop_protocol_error' | 'loop_error' | 'internal_error',
  result?: AgentLoopResult,
): ExecutionResult {
  const messages = {
    loop_stopped: 'Agent loop stopped without completing.',
    loop_protocol_error: 'Agent loop violated its lifecycle contract.',
    loop_error: 'Agent loop failed.',
    internal_error: 'Execution engine failed.',
  };
  return {
    status: 'FAILED',
    error: { code, message: messages[code] },
    ...(result === undefined ? {} : { loopResult: result }),
  };
}

/** Foreground, single-consumer execution with bounded in-memory terminal snapshots. */
export class DefaultExecutionEngine implements ExecutionEngine {
  private readonly active = new Map<string, Active>();
  private readonly terminal = new Map<string, ExecutionSnapshot>();
  private readonly limit: number;
  private readonly logger: Logger | undefined;

  constructor(options: DefaultExecutionEngineOptions = {}) {
    if (
      typeof options !== 'object' ||
      options === null ||
      Array.isArray(options)
    )
      throw new Error('Invalid execution engine options.');
    const configured = options.maxRetainedSnapshots;
    const limit = configured === undefined ? 1000 : configured;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0)
      throw new Error('Invalid execution snapshot retention limit.');
    this.limit = limit;
    try {
      this.logger =
        options.logger === undefined
          ? createLogger({ module: 'execution.engine' })
          : options.logger.child('execution.engine');
    } catch {
      this.logger = undefined;
    }
  }

  execute(request: ExecutionRequest): AsyncIterable<ExecutionEvent> {
    let claimed = false;
    return {
      [Symbol.asyncIterator]: () => {
        if (claimed)
          throw new Error('Execution stream can only be consumed once.');
        claimed = true;
        const consumption: Consumption = { consumerClosed: false };
        const iterator = this.run(request, consumption);
        let busy = false;
        let closed = false;
        const observe = <T>(pending: Promise<T>): Promise<T> => {
          void pending.catch(() => {});
          return pending;
        };
        const leave = () => {
          consumption.consumerClosed = true;
          closed = true;
          if (consumption.active) this.requestCancel(consumption.active);
        };
        return {
          next: () => {
            if (closed)
              return Promise.resolve({ done: true, value: undefined });
            if (busy)
              return observe(
                Promise.reject(
                  new Error(
                    'Concurrent execution stream reads are not supported.',
                  ),
                ),
              );
            busy = true;
            return observe(
              iterator.next().then(
                (value) => {
                  busy = false;
                  if (value.done) closed = true;
                  return value;
                },
                (error: unknown) => {
                  busy = false;
                  closed = true;
                  throw error;
                },
              ),
            );
          },
          return: () => {
            leave();
            return observe(iterator.return(undefined));
          },
          throw: (error?: unknown) => {
            leave();
            return observe(iterator.throw(error));
          },
        };
      },
    };
  }

  private requestCancel(active: Active): void {
    if (active.cancelRequested || active.finalized) return;
    active.cancelRequested = true;
    active.cancelWaiter?.();
    active.controller.abort();
  }

  cancel(executionId: string): boolean {
    const active = this.active.get(executionId);
    if (!active || active.finalized) return false;
    this.requestCancel(active);
    return true;
  }

  getSnapshot(executionId: string): ExecutionSnapshot | undefined {
    const value =
      this.active.get(executionId)?.snapshot ?? this.terminal.get(executionId);
    return value === undefined ? undefined : snapshot(value);
  }

  private diagnostic(code: string): void {
    try {
      const outcome: unknown = this.logger?.warn('Execution cleanup failed.', {
        code,
      });
      if (outcome !== undefined) void Promise.resolve(outcome).catch(() => {});
    } catch {
      /* Logging cannot determine execution state. */
    }
  }

  private commit(
    id: string,
    active: Active,
    result: ExecutionResult,
  ): ExecutionSnapshot {
    const copied = snapshot(result);
    if (active.cancelRequested)
      result = { status: 'CANCELLED', reason: 'Execution was cancelled.' };
    else result = copied;
    const terminal: ExecutionSnapshot = {
      executionId: id,
      status: result.status,
      startedAt: active.snapshot.startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Math.max(0, performance.now() - active.started),
      result,
    };
    active.finalized = true;
    active.external.removeEventListener('abort', active.onAbort);
    this.active.delete(id);
    this.terminal.set(id, terminal);
    while (this.terminal.size > this.limit)
      this.terminal.delete(this.terminal.keys().next().value!);
    return terminal;
  }

  private async nextLoop(
    active: Active,
    iterator: AsyncIterator<AgentLoopEvent>,
  ): Promise<IteratorResult<AgentLoopEvent> | undefined> {
    if (active.cancelRequested) return undefined;
    let wake!: () => void;
    const cancelled = new Promise<undefined>((resolve) => {
      wake = () => resolve(undefined);
    });
    active.cancelWaiter = wake;
    const pending = Promise.resolve().then(() => {
      // Cancellation can arrive between scheduling and the actual capability call.
      if (active.cancelRequested) return undefined;
      const next = Promise.resolve(iterator.next());
      active.pendingNext = next;
      return next;
    });
    try {
      const step = await Promise.race([pending, cancelled]);
      if (!active.cancelRequested) delete active.pendingNext;
      return step;
    } finally {
      if (active.cancelWaiter === wake) delete active.cancelWaiter;
    }
  }

  private closeLoop(active: Active): Promise<void> {
    if (active.cleanup) return active.cleanup;
    if (!active.loopDone) active.controller.abort();
    const cleanup = (async () => {
      const iterator = active.iterator;
      if (!iterator || active.loopDone) return;
      const close = iterator.return;
      let step = close
        ? await close.call(iterator)
        : active.pendingNext
          ? await active.pendingNext
          : await iterator.next();
      while (true) {
        if (
          !step ||
          typeof step !== 'object' ||
          (step.done !== undefined && typeof step.done !== 'boolean')
        )
          throw new Error('Loop cleanup did not confirm iterator closure.');
        if (step.done) break;
        // return is optional, and finalizers can yield: only actual iterator EOF confirms closure.
        step = await iterator.next();
      }
      active.loopDone = true;
    })();
    active.cleanup = cleanup;
    void cleanup.catch(() => {});
    return cleanup;
  }

  private async *run(
    request: ExecutionRequest,
    consumption: Consumption,
  ): AsyncGenerator<ExecutionEvent> {
    const prepared = prepare(request);
    const { executionId: id } = prepared;
    if (this.active.has(id) || this.terminal.has(id))
      throw new Error('Execution id is already registered.');
    const active: Active = {
      controller: new AbortController(),
      cancelRequested: false,
      finalized: false,
      external: prepared.signal,
      onAbort: () => {
        this.requestCancel(active);
      },
      started: performance.now(),
      snapshot: {
        executionId: id,
        status: 'RUNNING',
        startedAt: new Date().toISOString(),
      },
      loopDone: false,
    };
    this.active.set(id, active);
    consumption.active = active;
    if (prepared.signal.aborted) this.requestCancel(active);
    else
      prepared.signal.addEventListener('abort', active.onAbort, { once: true });
    const context = {
      ...prepared.context,
      control: { signal: active.controller.signal },
    };
    let terminal = false;
    let result: ExecutionResult = {
      status: 'CANCELLED',
      reason: 'Execution was cancelled.',
    };
    try {
      yield {
        type: 'execution_start',
        executionId: id,
        timestamp: active.snapshot.startedAt,
      };
      if (!active.cancelRequested) {
        const protocol = new LoopProtocol();
        try {
          const iterable = prepared.loop.run(context);
          if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function')
            throw new ProtocolError();
          const iterator = iterable[Symbol.asyncIterator]();
          if (!iterator || typeof iterator.next !== 'function')
            throw new ProtocolError();
          active.iterator = iterator;
          while (!active.cancelRequested) {
            const step = await this.nextLoop(active, iterator);
            if (active.cancelRequested) break;
            if (
              !step ||
              typeof step !== 'object' ||
              (step.done !== undefined && typeof step.done !== 'boolean')
            )
              throw new ProtocolError();
            if (step.done) {
              active.loopDone = true;
              break;
            }
            yield {
              type: 'loop_event',
              executionId: id,
              event: protocol.accept(step.value),
            };
          }
          if (!active.cancelRequested) {
            const value = protocol.result();
            result =
              value.status === 'completed'
                ? { status: 'COMPLETED', loopResult: value }
                : failed('loop_stopped', value);
          }
        } catch (error) {
          result = failed(
            isProtocolError(error) ? 'loop_protocol_error' : 'loop_error',
          );
        }
      }
      try {
        await this.closeLoop(active);
      } catch {
        this.diagnostic('loop_cleanup_failed');
        if (result.status === 'COMPLETED') result = failed('internal_error');
      }
      const value = this.commit(id, active, result);
      terminal = true;
      if (!consumption.consumerClosed)
        yield {
          type: 'execution_end',
          executionId: id,
          timestamp: value.endedAt!,
          result: snapshot(value.result!),
        };
    } catch {
      // Engine-owned failures are converted safely, without replacing a more specific Loop failure.
      if (!terminal) {
        try {
          await this.closeLoop(active);
        } catch {
          this.diagnostic('loop_cleanup_failed');
        }
        const value = this.commit(
          id,
          active,
          result.status === 'FAILED' ? result : failed('internal_error'),
        );
        terminal = true;
        if (!consumption.consumerClosed)
          yield {
            type: 'execution_end',
            executionId: id,
            timestamp: value.endedAt!,
            result: snapshot(value.result!),
          };
      }
    } finally {
      if (!terminal) {
        this.requestCancel(active);
        try {
          await this.closeLoop(active);
        } catch {
          this.diagnostic('loop_cleanup_failed');
        }
        this.commit(id, active, {
          status: 'CANCELLED',
          reason: 'Execution consumer stopped.',
        });
      }
      active.external.removeEventListener('abort', active.onAbort);
      delete consumption.active;
    }
  }
}
