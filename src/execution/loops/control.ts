import type {
  AgentLoopContext,
  AgentLoopEvent,
} from '../../harness/contracts/agent-loop/index.ts';
import { ModelError } from '../../harness/contracts/model/index.ts';
import { ToolExecutionError } from '../../harness/contracts/tool/index.ts';
import { invalidContext, object } from './snapshots.ts';

/** Per-run linked signal, shared by model and tool capabilities. No execution-wide timer. */
export class LoopControl {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly external: AbortSignal;
  private reason: ModelError | ToolExecutionError | undefined;
  private phase: 'model' | 'tool' = 'model';
  private completed = false;
  private readonly stopped: Promise<never>;
  private rejectStopped!: (error: ModelError | ToolExecutionError) => void;
  private readonly abort = () => this.cancel();

  constructor(signal: AbortSignal) {
    this.external = signal;
    this.signal = this.controller.signal;
    this.stopped = new Promise<never>((_resolve, reject) => {
      this.rejectStopped = reject;
    });
    void this.stopped.catch(() => {});
    if (signal.aborted) this.cancel();
    else signal.addEventListener('abort', this.abort, { once: true });
  }

  setPhase(phase: 'model' | 'tool'): void {
    this.phase = phase;
  }

  cancel(): void {
    if (this.reason || this.completed) return;
    this.reason =
      this.phase === 'tool'
        ? new ToolExecutionError('aborted', 'Agent loop was aborted.')
        : new ModelError({
            code: 'aborted',
            message: 'Agent loop was aborted.',
            retryable: false,
          });
    this.rejectStopped(this.reason);
    this.controller.abort();
  }

  check(): void {
    if (this.reason) throw this.reason;
  }

  async wait<T>(operation: () => PromiseLike<T> | T): Promise<T> {
    this.check();
    const pending = Promise.resolve().then(() => {
      this.check();
      return operation();
    });
    const result = await Promise.race([pending, this.stopped]);
    this.check();
    return result;
  }

  finish(): void {
    this.check();
    this.completed = true;
    this.dispose();
  }

  dispose(): void {
    this.external.removeEventListener('abort', this.abort);
    if (!this.completed) this.cancel();
  }
}

/** return() must cancel immediately, rather than wait behind an async generator's pending next(). */
export function controlledRun(
  context: AgentLoopContext,
  execute: (control: LoopControl) => AsyncGenerator<AgentLoopEvent>,
): AsyncIterableIterator<AgentLoopEvent> {
  let control: LoopControl | undefined;
  let iterator: AsyncGenerator<AgentLoopEvent> | undefined;
  let closed = false;
  const observe = <T>(pending: Promise<T>): Promise<T> => {
    void pending.catch(() => {});
    return pending;
  };
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      if (closed) return Promise.resolve({ done: true, value: undefined });
      try {
        if (!iterator) {
          if (
            !object(context) ||
            !object(context.control) ||
            !(context.control.signal instanceof AbortSignal)
          )
            invalidContext();
          control = new LoopControl(context.control.signal);
          iterator = execute(control);
        }
        const pending = iterator.next();
        void pending.then(
          (result) => {
            if (result.done) closed = true;
          },
          () => {
            closed = true;
          },
        );
        return observe(pending);
      } catch (error) {
        closed = true;
        control?.dispose();
        return observe(Promise.reject(error));
      }
    },
    return() {
      closed = true;
      control?.cancel();
      return iterator
        ? observe(iterator.return(undefined))
        : Promise.resolve({ done: true, value: undefined });
    },
    throw(error) {
      closed = true;
      control?.cancel();
      return iterator
        ? observe(iterator.throw(error))
        : observe(Promise.reject(error));
    },
  };
}
