import type {
  ModelFinishReason,
  ModelResponse,
  ModelStreamEvent,
  ModelToolCall,
  ModelUsage,
} from '../../../../harness/contracts/model/index.ts';
import {
  failure,
  invalidResponse,
  nonempty,
  record,
  toolName,
} from './errors.ts';
import { finishReason, metadata, usage } from './response.ts';

interface ToolBuffer {
  id?: string;
  name?: string;
  argumentsJson: string;
  hasArguments: boolean;
}

/** Constructed inside each stream, never retained on the reusable client. */
export class StreamState {
  private id: string | undefined;
  private model: string | undefined;
  private text = '';
  private hasText = false;
  private readonly tools = new Map<number, ToolBuffer>();
  private reason: ModelFinishReason | undefined;
  private tokenUsage: ModelUsage | undefined;
  private sawChoice = false;

  private readonly requestedModel: string;

  constructor(requestedModel: string) {
    this.requestedModel = requestedModel;
  }

  start(): ModelStreamEvent {
    return {
      type: 'message_start',
      ...(this.id === undefined ? {} : { id: this.id }),
      model: this.model ?? this.requestedModel,
    };
  }

  consume(value: unknown): ModelStreamEvent[] {
    if (!record(value)) return invalidResponse();
    if (value.error !== undefined)
      throw failure(
        'provider_error',
        'Model provider reported a stream error.',
      );
    const info = metadata(value, this.requestedModel);
    if (value.id !== undefined) {
      if (this.id !== undefined && this.id !== info.id)
        return invalidResponse();
      this.id = info.id;
    }
    if (value.model !== undefined) {
      if (this.model !== undefined && this.model !== info.model)
        return invalidResponse();
      this.model = info.model;
    }
    const mappedUsage = usage(value.usage);
    if (mappedUsage !== undefined)
      this.tokenUsage = { ...this.tokenUsage, ...mappedUsage };
    if (!Array.isArray(value.choices) || value.choices.length > 1)
      return invalidResponse();
    if (value.choices.length === 0) {
      if (mappedUsage === undefined || !this.reason) return invalidResponse();
      return [];
    }
    const choice: unknown = value.choices[0];
    if (
      !record(choice) ||
      choice.index !== 0 ||
      !record(choice.delta) ||
      this.reason !== undefined
    )
      return invalidResponse();
    this.sawChoice = true;
    const delta = choice.delta;
    if (delta.role !== undefined && delta.role !== 'assistant')
      return invalidResponse();
    if (delta.function_call != null || delta.audio != null)
      throw failure(
        'unsupported_capability',
        'This adapter supports text and function tools only.',
      );
    const events: ModelStreamEvent[] = [];
    if (delta.content !== undefined && delta.content !== null) {
      if (typeof delta.content !== 'string') return invalidResponse();
      this.hasText = true;
      this.text += delta.content;
      if (delta.content !== '')
        events.push({ type: 'text_delta', text: delta.content });
    }
    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls)) return invalidResponse();
      for (const item of delta.tool_calls as unknown[])
        events.push(this.toolDelta(item));
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null)
      this.reason = finishReason(choice.finish_reason);
    return events;
  }

  private toolDelta(value: unknown): ModelStreamEvent {
    if (
      !record(value) ||
      typeof value.index !== 'number' ||
      !Number.isSafeInteger(value.index) ||
      value.index < 0 ||
      (value.type !== undefined && value.type !== 'function') ||
      (value.function !== undefined && !record(value.function))
    )
      return invalidResponse();
    const current = this.tools.get(value.index) ?? {
      argumentsJson: '',
      hasArguments: false,
    };
    const event: Extract<ModelStreamEvent, { type: 'tool_call_delta' }> = {
      type: 'tool_call_delta',
      index: value.index,
    };
    if (value.id !== undefined) {
      if (
        !nonempty(value.id) ||
        (current.id !== undefined && current.id !== value.id)
      )
        return invalidResponse();
      current.id = event.id = value.id;
    }
    if (record(value.function)) {
      const fn = value.function;
      if (fn.name !== undefined) {
        if (
          !toolName(fn.name) ||
          (current.name !== undefined && current.name !== fn.name)
        )
          return invalidResponse();
        current.name = event.name = fn.name;
      }
      if (fn.arguments !== undefined) {
        if (typeof fn.arguments !== 'string') return invalidResponse();
        current.hasArguments = true;
        current.argumentsJson += fn.arguments;
        event.argumentsDelta = fn.arguments;
      }
    }
    this.tools.set(value.index, current);
    return event;
  }

  response(): ModelResponse {
    if (!this.sawChoice || this.reason === undefined) return invalidResponse();
    const calls: ModelToolCall[] = [...this.tools.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tool]) => {
        if (!tool.id || !tool.name || !tool.hasArguments)
          return invalidResponse();
        return {
          id: tool.id,
          name: tool.name,
          argumentsJson: tool.argumentsJson,
        };
      });
    if (new Set(calls.map((call) => call.id)).size !== calls.length)
      return invalidResponse();
    if (this.reason === 'tool_calls' && calls.length === 0)
      return invalidResponse();
    return {
      ...(this.id === undefined ? {} : { id: this.id }),
      model: this.model ?? this.requestedModel,
      message: {
        role: 'assistant',
        content: this.hasText ? this.text : null,
        ...(calls.length ? { toolCalls: calls } : {}),
      },
      finishReason: this.reason,
      ...(this.tokenUsage === undefined ? {} : { usage: this.tokenUsage }),
    };
  }
}
