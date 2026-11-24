import type {
  ModelResponse,
  ModelStreamEvent,
  ModelToolCall,
} from '../../../../harness/contracts/model/index.ts';
import {
  failure,
  invalidResponse,
  nonempty,
  record,
  toolName,
} from '../openai-compatible/errors.ts';
import { mapResponse } from './response.ts';

interface ToolState {
  index: number;
  callId?: string;
  name?: string;
  argumentsJson: string;
}

export interface ResponsesStreamUpdate {
  events: ModelStreamEvent[];
  response?: ModelResponse;
}

/** Per-call Responses event assembler; no state is retained by the reusable client. */
export class ResponsesStreamState {
  private readonly requestedModel: string;
  private id: string | undefined;
  private model: string | undefined;
  private text = '';
  private readonly toolsByOutput = new Map<number, ToolState>();
  private terminal = false;

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

  private metadata(response: unknown): void {
    if (!record(response)) return invalidResponse();
    if (response.id !== undefined) {
      if (!nonempty(response.id)) return invalidResponse();
      if (this.id !== undefined && this.id !== response.id) {
        return invalidResponse();
      }
      this.id = response.id;
    }
    if (response.model !== undefined) {
      if (!nonempty(response.model)) return invalidResponse();
      if (this.model !== undefined && this.model !== response.model) {
        return invalidResponse();
      }
      this.model = response.model;
    }
  }

  private tool(
    outputIndex: unknown,
    item: Record<string, unknown> | undefined,
  ): {
    state: ToolState;
    event: Extract<ModelStreamEvent, { type: 'tool_call_delta' }>;
  } {
    if (
      typeof outputIndex !== 'number' ||
      !Number.isSafeInteger(outputIndex) ||
      outputIndex < 0
    ) {
      return invalidResponse();
    }
    let state = this.toolsByOutput.get(outputIndex);
    if (!state) {
      state = {
        index: this.toolsByOutput.size,
        argumentsJson: '',
      };
      this.toolsByOutput.set(outputIndex, state);
    }
    const event: Extract<ModelStreamEvent, { type: 'tool_call_delta' }> = {
      type: 'tool_call_delta',
      index: state.index,
    };
    if (item) {
      if (item.type !== 'function_call') return invalidResponse();
      if (item.call_id !== undefined) {
        if (
          !nonempty(item.call_id) ||
          (state.callId !== undefined && state.callId !== item.call_id)
        ) {
          return invalidResponse();
        }
        if (state.callId === undefined) event.id = item.call_id;
        state.callId = item.call_id;
      }
      if (item.name !== undefined) {
        if (
          !toolName(item.name) ||
          (state.name !== undefined && state.name !== item.name)
        ) {
          return invalidResponse();
        }
        if (state.name === undefined) event.name = item.name;
        state.name = item.name;
      }
      if (item.arguments !== undefined) {
        if (typeof item.arguments !== 'string') return invalidResponse();
        if (!item.arguments.startsWith(state.argumentsJson)) {
          return invalidResponse();
        }
        const suffix = item.arguments.slice(state.argumentsJson.length);
        if (suffix) event.argumentsDelta = suffix;
        state.argumentsJson = item.arguments;
      }
    }
    return { state, event };
  }

  private terminalResponse(value: unknown): ResponsesStreamUpdate {
    const response = mapResponse(value, this.requestedModel);
    this.metadata(value);
    const events: ModelStreamEvent[] = [];
    const finalText = response.message.content ?? '';
    if (!finalText.startsWith(this.text)) return invalidResponse();
    const textSuffix = finalText.slice(this.text.length);
    if (textSuffix) events.push({ type: 'text_delta', text: textSuffix });
    this.text = finalText;
    const finalCalls = response.message.toolCalls ?? [];
    for (const [outputIndex, call] of finalCalls.entries()) {
      let match: ToolState | undefined;
      for (const state of this.toolsByOutput.values()) {
        if (state.callId === call.id || state.index === outputIndex) {
          match = state;
          break;
        }
      }
      const pair = this.tool(
        match === undefined
          ? outputIndex
          : [...this.toolsByOutput.entries()].find(
              ([, state]) => state === match,
            )![0],
        {
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.argumentsJson,
        },
      );
      if (
        pair.event.id !== undefined ||
        pair.event.name !== undefined ||
        pair.event.argumentsDelta !== undefined
      ) {
        events.push(pair.event);
      }
    }
    const assembled: ModelToolCall[] = [...this.toolsByOutput.values()]
      .sort((a, b) => a.index - b.index)
      .map((tool) => {
        if (!tool.callId || !tool.name) return invalidResponse();
        return {
          id: tool.callId,
          name: tool.name,
          argumentsJson: tool.argumentsJson,
        };
      });
    if (
      JSON.stringify(assembled) !== JSON.stringify(finalCalls) ||
      this.terminal
    ) {
      return invalidResponse();
    }
    this.terminal = true;
    return { events, response };
  }

  consume(value: unknown): ResponsesStreamUpdate {
    if (!record(value) || typeof value.type !== 'string' || this.terminal) {
      return invalidResponse();
    }
    if (value.type === 'error' || value.type === 'response.failed') {
      throw failure(
        'provider_error',
        'Model provider reported a stream error.',
      );
    }
    if (value.type === 'response.created') {
      this.metadata(value.response);
      return { events: [] };
    }
    if (value.type === 'response.output_text.delta') {
      if (typeof value.delta !== 'string') return invalidResponse();
      this.text += value.delta;
      return {
        events: value.delta ? [{ type: 'text_delta', text: value.delta }] : [],
      };
    }
    if (value.type === 'response.output_item.added') {
      if (!record(value.item)) return invalidResponse();
      if (value.item.type !== 'function_call') return { events: [] };
      const event = this.tool(value.output_index, value.item).event;
      return { events: [event] };
    }
    if (value.type === 'response.function_call_arguments.delta') {
      if (typeof value.delta !== 'string') return invalidResponse();
      const pair = this.tool(value.output_index, undefined);
      pair.state.argumentsJson += value.delta;
      return {
        events: value.delta
          ? [
              {
                type: 'tool_call_delta',
                index: pair.state.index,
                argumentsDelta: value.delta,
              },
            ]
          : [],
      };
    }
    if (value.type === 'response.function_call_arguments.done') {
      if (typeof value.arguments !== 'string') return invalidResponse();
      const pair = this.tool(value.output_index, {
        type: 'function_call',
        arguments: value.arguments,
      });
      return {
        events: pair.event.argumentsDelta === undefined ? [] : [pair.event],
      };
    }
    if (value.type === 'response.output_item.done') {
      if (!record(value.item) || value.item.type !== 'function_call') {
        return { events: [] };
      }
      const pair = this.tool(value.output_index, value.item);
      return {
        events:
          pair.event.id !== undefined ||
          pair.event.name !== undefined ||
          pair.event.argumentsDelta !== undefined
            ? [pair.event]
            : [],
      };
    }
    if (
      value.type === 'response.completed' ||
      value.type === 'response.incomplete'
    ) {
      return this.terminalResponse(value.response);
    }
    return { events: [] };
  }
}
