import {
  ToolExecutionError,
  type ToolExecutionOptions,
} from '../../harness/contracts/tool/index.ts';

/** Capture option values once; malformed control options are ordinary invalid input. */
export function copyOptions(
  options: unknown,
): ToolExecutionOptions | undefined {
  try {
    if (options === undefined) return {};
    if (
      typeof options !== 'object' ||
      options === null ||
      Array.isArray(options)
    )
      return undefined;
    const signal: unknown = 'signal' in options ? options.signal : undefined;
    const timeoutMs: unknown =
      'timeoutMs' in options ? options.timeoutMs : undefined;
    if (signal !== undefined && !(signal instanceof AbortSignal))
      return undefined;
    if (
      timeoutMs !== undefined &&
      (typeof timeoutMs !== 'number' ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > 2_147_483_647)
    )
      return undefined;
    return {
      ...(signal === undefined ? {} : { signal }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    };
  } catch {
    return undefined;
  }
}

/** Only signal/timeout owned by this invocation can produce a control exception. */
export class ExecutionControl {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly external: AbortSignal | undefined;
  private readonly deadline: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private reason: ToolExecutionError | undefined;
  private readonly stopped: Promise<never>;
  private rejectStopped!: (error: ToolExecutionError) => void;
  private readonly onAbort = () => this.stop('aborted');

  constructor(options?: ToolExecutionOptions) {
    this.signal = this.controller.signal;
    this.external = options?.signal;
    this.deadline =
      options?.timeoutMs === undefined
        ? undefined
        : performance.now() + options.timeoutMs;
    this.stopped = new Promise<never>((_resolve, reject) => {
      this.rejectStopped = reject;
    });
    void this.stopped.catch(() => {});
    if (this.external?.aborted) this.stop('aborted');
    else this.external?.addEventListener('abort', this.onAbort, { once: true });
    if (options?.timeoutMs !== undefined && !this.reason)
      this.timer = setTimeout(() => this.stop('timeout'), options.timeoutMs);
  }

  private stop(code: 'aborted' | 'timeout'): void {
    if (this.reason) return;
    this.reason = new ToolExecutionError(
      code,
      code === 'aborted'
        ? 'Tool execution was aborted.'
        : 'Tool execution timed out.',
    );
    this.rejectStopped(this.reason);
    this.controller.abort();
  }

  interruption(): ToolExecutionError | undefined {
    if (
      !this.reason &&
      this.deadline !== undefined &&
      performance.now() >= this.deadline
    )
      this.stop('timeout');
    return this.reason;
  }

  check(): void {
    const reason = this.interruption();
    if (reason) throw reason;
  }

  async run<T>(operation: () => T | PromiseLike<T>): Promise<T> {
    this.check();
    const pending = Promise.resolve().then(() => {
      this.check();
      return operation();
    });
    const result = await Promise.race([pending, this.stopped]);
    this.check();
    return result;
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.external?.removeEventListener('abort', this.onAbort);
  }
}
