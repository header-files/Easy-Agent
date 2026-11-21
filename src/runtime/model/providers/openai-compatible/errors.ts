import {
  ModelError,
  type ModelErrorCode,
} from '../../../../harness/contracts/model/index.ts';

export function failure(
  code: ModelErrorCode,
  message: string,
  status?: number,
): ModelError {
  return new ModelError({
    code,
    message,
    retryable: ['network', 'timeout', 'rate_limit', 'provider_error'].includes(
      code,
    ),
    ...(status === undefined ? {} : { status }),
  });
}

export function httpError(status: number): ModelError {
  const code =
    status === 401 || status === 403
      ? 'authentication'
      : status === 429
        ? 'rate_limit'
        : [400, 404, 405, 409, 413, 422].includes(status)
          ? 'invalid_request'
          : status === 408 || status === 504
            ? 'timeout'
            : 'provider_error';
  return failure(code, `Model provider returned HTTP ${status}.`, status);
}

export function invalidResponse(): never {
  throw failure(
    'invalid_response',
    'Model provider returned an invalid response.',
  );
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function toolName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}
