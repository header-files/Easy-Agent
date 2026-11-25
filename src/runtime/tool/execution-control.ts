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
    const approvalTimeoutMs: unknown =
      'approvalTimeoutMs' in options ? options.approvalTimeoutMs : undefined;
    const workspaceId: unknown =
      'workspaceId' in options ? options.workspaceId : undefined;
    const sessionId: unknown =
      'sessionId' in options ? options.sessionId : undefined;
    const executionId: unknown =
      'executionId' in options ? options.executionId : undefined;
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
    if (
      approvalTimeoutMs !== undefined &&
      (typeof approvalTimeoutMs !== 'number' ||
        !Number.isSafeInteger(approvalTimeoutMs) ||
        approvalTimeoutMs <= 0 ||
        approvalTimeoutMs > 2_147_483_647)
    )
      return undefined;
    for (const value of [workspaceId, sessionId, executionId]) {
      if (value !== undefined && typeof value !== 'string') return undefined;
    }
    return {
      ...(signal === undefined ? {} : { signal }),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(approvalTimeoutMs === undefined ? {} : { approvalTimeoutMs }),
      ...(workspaceId === undefined
        ? {}
        : { workspaceId: workspaceId as string }),
      ...(sessionId === undefined ? {} : { sessionId: sessionId as string }),
      ...(executionId === undefined
        ? {}
        : { executionId: executionId as string }),
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

  /**
   * Like `run`, but after timeout/abort still waits for `operation` to settle
   * (or a grace period) before returning. Use when a Workspace lock must not be
   * released while the handler / process cleanup may still be running.
   * `onAbandoned` runs only when the operation is still pending after graceMs.
   */
  async runUntilSettled<T>(
    operation: () => T | PromiseLike<T>,
    options: { graceMs?: number; onAbandoned?: () => void } = {},
  ): Promise<T> {
    this.check();
    const pending = Promise.resolve().then(() => {
      this.check();
      return operation();
    });
    // Prevent unhandled rejection if we abandon after grace.
    void pending.catch(() => {});
    try {
      const result = await Promise.race([pending, this.stopped]);
      this.check();
      return result;
    } catch (error) {
      const interruption = this.interruption();
      if (!interruption) throw error;
      const graceMs = options.graceMs ?? 5_000;
      const settled = await Promise.race([
        pending.then(
          () => true,
          () => true,
        ),
        delay(graceMs).then(() => false),
      ]);
      if (!settled) options.onAbandoned?.();
      throw interruption;
    }
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.external?.removeEventListener('abort', this.onAbort);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
