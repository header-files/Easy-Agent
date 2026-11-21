import {
  ModelError,
  type ModelCallOptions,
} from '../../../../harness/contracts/model/index.ts';
import { failure } from './errors.ts';

/** All mutable lifetime and cancellation state belongs to one invocation. */
export class CallContext {
  readonly controller = new AbortController();
  private reason: ModelError | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly externalSignal: AbortSignal | undefined;
  private readonly onExternalAbort = () =>
    this.stop(failure('aborted', 'Model request was aborted.'));
  private readonly stopped: Promise<never>;
  private rejectStopped!: (reason: ModelError) => void;

  constructor(options: ModelCallOptions | undefined) {
    if (
      options !== undefined &&
      (typeof options !== 'object' ||
        options === null ||
        Array.isArray(options))
    )
      throw failure('invalid_request', 'Call options must be an object.');
    if (
      options?.timeoutMs !== undefined &&
      (typeof options.timeoutMs !== 'number' ||
        !Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs <= 0 ||
        options.timeoutMs > 2_147_483_647)
    )
      throw failure(
        'invalid_request',
        'timeoutMs must be a positive integer no larger than 2147483647.',
      );
    if (
      options?.signal !== undefined &&
      !(options.signal instanceof AbortSignal)
    )
      throw failure('invalid_request', 'signal must be an AbortSignal.');
    this.externalSignal = options?.signal;
    this.stopped = new Promise<never>((_resolve, reject) => {
      this.rejectStopped = reject;
    });
    // A stream may be paused by its consumer when cancellation occurs.
    void this.stopped.catch(() => {});
    if (this.externalSignal?.aborted) this.onExternalAbort();
    else
      this.externalSignal?.addEventListener('abort', this.onExternalAbort, {
        once: true,
      });
    if (options?.timeoutMs !== undefined && !this.reason)
      this.timer = setTimeout(
        () => this.stop(failure('timeout', 'Model request timed out.')),
        options.timeoutMs,
      );
  }

  private stop(reason: ModelError): void {
    if (this.reason) return;
    this.reason = reason;
    this.rejectStopped(reason);
    this.controller.abort();
  }

  check(): void {
    if (this.reason) throw this.reason;
  }

  async run<T>(operation: Promise<T>): Promise<T> {
    // Observe an already-created operation even if cancellation won synchronously.
    void operation.catch(() => {});
    this.check();
    return Promise.race([operation, this.stopped]);
  }

  error(error: unknown): ModelError {
    if (this.reason) return this.reason;
    if (error instanceof ModelError) return error;
    return failure(
      'network',
      'Model provider could not be reached or the connection failed.',
    );
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.externalSignal?.removeEventListener('abort', this.onExternalAbort);
    this.controller.abort();
  }
}
