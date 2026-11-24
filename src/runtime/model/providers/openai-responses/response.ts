import type {
  ModelFinishReason,
  ModelResponse,
  ModelToolCall,
  ModelUsage,
} from '../../../../harness/contracts/model/index.ts';
import {
  failure,
  invalidResponse,
  nonempty,
  record,
  toolName,
} from '../openai-compatible/errors.ts';

function usage(value: unknown): ModelUsage | undefined {
  if (value === undefined || value === null) return undefined;
  if (!record(value)) return invalidResponse();
  const result: ModelUsage = {};
  for (const [native, unified] of [
    ['input_tokens', 'inputTokens'],
    ['output_tokens', 'outputTokens'],
    ['total_tokens', 'totalTokens'],
  ] as const) {
    const count = value[native];
    if (count !== undefined) {
      if (
        typeof count !== 'number' ||
        !Number.isSafeInteger(count) ||
        count < 0
      ) {
        return invalidResponse();
      }
      result[unified] = count;
    }
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function reason(value: Record<string, unknown>): ModelFinishReason {
  if (value.status === 'completed') return 'stop';
  if (value.status !== 'incomplete') {
    throw failure(
      'provider_error',
      'Model provider did not complete response.',
    );
  }
  const details = value.incomplete_details;
  if (!record(details)) return 'other';
  if (details.reason === 'max_output_tokens') return 'length';
  if (details.reason === 'content_filter') return 'content_filter';
  return 'other';
}

/** Map a terminal Responses object without relying on provider-side conversation state. */
export function mapResponse(
  value: unknown,
  requestedModel: string,
): ModelResponse {
  if (!record(value)) return invalidResponse();
  if (value.error != null) {
    throw failure('provider_error', 'Model provider reported an error.');
  }
  if (!Array.isArray(value.output)) return invalidResponse();
  const text: string[] = [];
  const calls: ModelToolCall[] = [];
  for (const item of value.output as unknown[]) {
    if (!record(item) || typeof item.type !== 'string') {
      return invalidResponse();
    }
    if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content)) {
        return invalidResponse();
      }
      for (const content of item.content as unknown[]) {
        if (!record(content)) return invalidResponse();
        if (content.type === 'output_text') {
          if (typeof content.text !== 'string') return invalidResponse();
          text.push(content.text);
        } else if (content.type === 'refusal') {
          throw failure(
            'unsupported_capability',
            'Responses refusal content is not represented by the unified text contract.',
          );
        }
      }
    } else if (item.type === 'function_call') {
      if (
        !nonempty(item.call_id) ||
        !toolName(item.name) ||
        typeof item.arguments !== 'string'
      ) {
        return invalidResponse();
      }
      calls.push({
        id: item.call_id,
        name: item.name,
        argumentsJson: item.arguments,
      });
    }
  }
  if (new Set(calls.map((call) => call.id)).size !== calls.length) {
    return invalidResponse();
  }
  const finishReason = calls.length ? 'tool_calls' : reason(value);
  const mappedUsage = usage(value.usage);
  if (value.id !== undefined && !nonempty(value.id)) return invalidResponse();
  if (value.model !== undefined && !nonempty(value.model)) {
    return invalidResponse();
  }
  return {
    ...(typeof value.id === 'string' ? { id: value.id } : {}),
    model: typeof value.model === 'string' ? value.model : requestedModel,
    message: {
      role: 'assistant',
      content: text.length ? text.join('') : null,
      ...(calls.length ? { toolCalls: calls } : {}),
    },
    finishReason,
    ...(mappedUsage === undefined ? {} : { usage: mappedUsage }),
  };
}
