export type ToolExecutionErrorCode = 'aborted' | 'timeout';

/** Execution control failures stay distinct from ordinary tool business results. */
export class ToolExecutionError extends Error {
  readonly code: ToolExecutionErrorCode;

  constructor(code: ToolExecutionErrorCode, message: string) {
    super(message);
    this.name = 'ToolExecutionError';
    this.code = code;
  }
}
