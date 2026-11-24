import { ModelError } from '../../../../harness/contracts/model/index.ts';
import type { Logger } from '../../../logging/index.ts';
import type {
  ModelCallOptions,
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from '../../../../harness/contracts/model/index.ts';
import { CallContext } from './call-context.ts';
import { failure, httpError, invalidResponse } from './errors.ts';
import { mapRequest, type MaxTokensField } from './request.ts';
import { mapResponse } from './response.ts';
import { sse } from './sse.ts';
import { StreamState } from './stream-state.ts';
import { clientLogger, LifecycleLog } from './lifecycle-log.ts';

export interface OpenAICompatibleConfig {
  /** Required endpoint root; caller supplies the vendor or proxy URL. */
  baseURL: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  maxTokensField?: MaxTokensField;
  logger?: Logger;
}

/** Reusable configuration and transport; every call owns its mutable state. */
export class OpenAICompatibleModelClient implements ModelClient {
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly fetch: typeof globalThis.fetch;
  private readonly maxTokensField: MaxTokensField;
  private readonly logger: Logger | undefined;
  private readonly redactValues: readonly string[];

  constructor(config: OpenAICompatibleConfig) {
    if (typeof config !== 'object' || config === null || Array.isArray(config))
      throw failure(
        'invalid_request',
        'Provider configuration must be an object.',
      );
    if (typeof config.baseURL !== 'string' || config.baseURL.length === 0) {
      throw failure(
        'invalid_request',
        'baseURL is required and must be a non-empty string.',
      );
    }
    try {
      const url = new URL(config.baseURL);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
      this.endpoint = url.href;
    } catch (error) {
      if (error instanceof ModelError) throw error;
      throw failure(
        'invalid_request',
        'baseURL must be an HTTP(S) URL without credentials, query or fragment.',
      );
    }
    if (
      config.apiKey !== undefined &&
      (typeof config.apiKey !== 'string' || /[\r\n]/.test(config.apiKey))
    )
      throw failure('invalid_request', 'apiKey must be a valid header value.');
    if (config.fetch !== undefined && typeof config.fetch !== 'function')
      throw failure('invalid_request', 'fetch must be a function.');
    if (
      config.maxTokensField !== undefined &&
      !['max_completion_tokens', 'max_tokens'].includes(config.maxTokensField)
    )
      throw failure('invalid_request', 'Unknown token limit field.');
    this.apiKey = config.apiKey;
    this.fetch = config.fetch ?? globalThis.fetch;
    this.maxTokensField = config.maxTokensField ?? 'max_completion_tokens';
    this.redactValues = this.apiKey ? [this.apiKey] : [];
    this.logger = clientLogger(config.logger, this.apiKey);
  }

  private async send(
    body: Record<string, unknown>,
    context: CallContext,
  ): Promise<Response> {
    context.check();
    const pending = this.fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: body.stream ? 'text/event-stream' : 'application/json',
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: context.controller.signal,
    });
    // A custom fetch can ignore AbortSignal and return a body after cancellation.
    void pending.then(
      (response) => {
        if (context.controller.signal.aborted)
          void response.body?.cancel().catch(() => {});
      },
      () => {},
    );
    const response = await context.run(pending);
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw httpError(response.status);
    }
    return response;
  }

  private async readJson(
    response: Response,
    context: CallContext,
  ): Promise<unknown> {
    if (!response.body) return invalidResponse();
    const reader = response.body.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    context.controller.signal.addEventListener('abort', cancel, { once: true });
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    try {
      while (true) {
        const part = await context.run(reader.read());
        try {
          text += part.done
            ? decoder.decode()
            : decoder.decode(part.value, { stream: true });
        } catch {
          return invalidResponse();
        }
        if (part.done) break;
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return invalidResponse();
      }
    } finally {
      context.controller.signal.removeEventListener('abort', cancel);
      cancel();
      reader.releaseLock();
    }
  }

  async generate(
    request: ModelRequest,
    options?: ModelCallOptions,
  ): Promise<ModelResponse> {
    const log = new LifecycleLog(
      this.logger,
      'generate',
      request,
      this.redactValues,
    );
    let context: CallContext | undefined;
    let response: Response | undefined;
    try {
      const body = mapRequest(request, false, this.maxTokensField);
      const requestedModel = String(body.model);
      log.setModel(requestedModel);
      context = new CallContext(options);
      response = await this.send(body, context);
      const value = await this.readJson(response, context);
      context.check();
      const result = mapResponse(value, requestedModel);
      context.dispose();
      log.completed(result);
      return result;
    } catch (error) {
      const mapped =
        context?.error(error) ??
        (error instanceof ModelError
          ? error
          : failure('invalid_request', 'Model request could not be prepared.'));
      log.failed(mapped);
      throw mapped;
    } finally {
      context?.dispose();
      if (response?.body && !response.body.locked)
        void response.body.cancel().catch(() => {});
    }
  }

  async *stream(
    request: ModelRequest,
    options?: ModelCallOptions,
  ): AsyncIterable<ModelStreamEvent> {
    const log = new LifecycleLog(
      this.logger,
      'stream',
      request,
      this.redactValues,
    );
    let context: CallContext | undefined;
    let response: Response | undefined;
    try {
      const body = mapRequest(request, true, this.maxTokensField);
      const requestedModel = String(body.model);
      log.setModel(requestedModel);
      context = new CallContext(options);
      response = await this.send(body, context);
      if (!response.body) return invalidResponse();
      const state = new StreamState(requestedModel);
      let started = false;
      let result: ModelResponse | undefined;
      for await (const data of sse(response.body, context)) {
        context.check();
        if (data === '[DONE]') {
          result = state.response();
          break;
        }
        let chunk: unknown;
        try {
          chunk = JSON.parse(data);
        } catch {
          return invalidResponse();
        }
        const events = state.consume(chunk);
        if (!started) {
          started = true;
          yield state.start();
        }
        for (const event of events) {
          context.check();
          yield event;
        }
      }
      if (result === undefined) return invalidResponse();
      context.check();
      // Release the reader/timer and log completion before exposing the terminal event.
      context.dispose();
      log.completed(result);
      yield { type: 'message_end', response: result };
    } catch (error) {
      const mapped =
        context?.error(error) ??
        (error instanceof ModelError
          ? error
          : failure('invalid_request', 'Model request could not be prepared.'));
      log.failed(mapped);
      throw mapped;
    } finally {
      let interruption: ModelError | undefined;
      try {
        context?.check();
      } catch (error) {
        if (error instanceof ModelError) interruption = error;
      }
      context?.dispose();
      if (response?.body && !response.body.locked)
        void response.body.cancel().catch(() => {});
      if (interruption) log.failed(interruption);
      log.returned();
    }
  }
}
