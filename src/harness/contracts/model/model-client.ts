import type { ModelRequest } from './model-request.ts';
import type { ModelResponse } from './model-response.ts';
import type { ModelStreamEvent } from './model-stream.ts';

export interface ModelCallOptions {
  signal?: AbortSignal;
  /** Total call duration; a lazy stream starts timing when consumption begins. */
  timeoutMs?: number;
}

/** Reusable provider-independent component, with isolated state for concurrent calls. */
export interface ModelClient {
  generate(
    request: ModelRequest,
    options?: ModelCallOptions,
  ): Promise<ModelResponse>;
  stream(
    request: ModelRequest,
    options?: ModelCallOptions,
  ): AsyncIterable<ModelStreamEvent>;
}
