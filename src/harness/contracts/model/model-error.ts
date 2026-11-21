export type ModelErrorCode =
  | 'authentication'
  | 'rate_limit'
  | 'invalid_request'
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'invalid_response'
  | 'unsupported_capability'
  | 'provider_error';

export interface ModelErrorInfo {
  code: ModelErrorCode;
  message: string;
  /** A hint to the caller; the adapter does not automatically retry requests. */
  retryable: boolean;
  status?: number;
}

/** Runtime adapters must supply a public message without credentials or headers. */
export class ModelError extends Error implements ModelErrorInfo {
  readonly code: ModelErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(info: ModelErrorInfo, options?: ErrorOptions) {
    super(info.message, options);
    this.name = 'ModelError';
    this.code = info.code;
    this.retryable = info.retryable;
    if (info.status !== undefined) this.status = info.status;
  }
}
