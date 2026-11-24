import { ModelError } from '../../../../harness/contracts/model/index.ts';
import type { Logger } from '../../../logging/index.ts';
import type {
  ModelCallOptions,
  ModelClient,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
} from '../../../../harness/contracts/model/index.ts';
import { CallContext } from '../openai-compatible/call-context.ts';
import {
  failure,
  httpError,
  invalidResponse,
} from '../openai-compatible/errors.ts';
import {
  clientLogger,
  LifecycleLog,
} from '../openai-compatible/lifecycle-log.ts';
import { sse } from '../openai-compatible/sse.ts';
import { mapRequest } from './request.ts';
import { mapResponse } from './response.ts';
import { ResponsesStreamState } from './stream-state.ts';

export interface OpenAIResponsesConfig {
  /** Required endpoint root; caller supplies the vendor or proxy URL. */
  baseURL: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  logger?: Logger;
}

/** Native OpenAI Responses adapter using caller-owned complete local history. */
export class OpenAIResponsesModelClient implements ModelClient {
  private readonly endpoint: string;
  private readonly apiKey: string | undefined;
  private readonly fetch: typeof globalThis.fetch;
  private readonly logger: Logger | undefined;
  private readonly redactValues: readonly string[];

  constructor(config: OpenAIResponsesConfig) {
    if (
      typeof config !== 'object' ||
      config === null ||
      Array.isArray(config)
    ) {
      throw failure(
        'invalid_request',
        'Provider configuration must be an object.',
      );
    }
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
      ) {
        throw new Error();
      }
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/responses`;
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
    ) {
      throw failure('invalid_request', 'apiKey must be a valid header value.');
    }
    if (config.fetch !== undefined && typeof config.fetch !== 'function') {
      throw failure('invalid_request', 'fetch must be a function.');
    }
    this.apiKey = config.apiKey;
    this.fetch = config.fetch ?? globalThis.fetch;
    this.redactValues = this.apiKey ? [this.apiKey] : [];
    this.logger = clientLogger(
      config.logger,
      this.apiKey,
      'runtime.model.openai-responses',
    );
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
    void pending.then(
      (response) => {
        if (context.controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
        }
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
      const body = mapRequest(request, false);
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
      if (response?.body && !response.body.locked) {
        void response.body.cancel().catch(() => {});
      }
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
      const body = mapRequest(request, true);
      const requestedModel = String(body.model);
      log.setModel(requestedModel);
      context = new CallContext(options);
      response = await this.send(body, context);
      if (!response.body) return invalidResponse();
      const state = new ResponsesStreamState(requestedModel);
      let started = false;
      let result: ModelResponse | undefined;
      for await (const data of sse(response.body, context)) {
        context.check();
        if (data === '[DONE]') break;
        let value: unknown;
        try {
          value = JSON.parse(data);
        } catch {
          return invalidResponse();
        }
        const update = state.consume(value);
        if (!started) {
          started = true;
          yield state.start();
        }
        for (const event of update.events) {
          context.check();
          yield event;
        }
        if (update.response !== undefined) {
          result = update.response;
          break;
        }
      }
      if (result === undefined) return invalidResponse();
      context.check();
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
      if (response?.body && !response.body.locked) {
        void response.body.cancel().catch(() => {});
      }
      if (interruption) log.failed(interruption);
      log.returned();
    }
  }
}
