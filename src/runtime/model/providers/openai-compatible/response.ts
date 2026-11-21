import type {
  AssistantMessage,
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
} from './errors.ts';

export function finishReason(value: unknown): ModelFinishReason {
  if (!nonempty(value)) return invalidResponse();
  if (value === 'function_call')
    throw failure(
      'unsupported_capability',
      'Legacy function calls are unsupported.',
    );
  return ['stop', 'tool_calls', 'length', 'content_filter'].includes(value)
    ? (value as ModelFinishReason)
    : 'other';
}

export function usage(value: unknown): ModelUsage | undefined {
  if (value === undefined || value === null) return undefined;
  if (!record(value)) return invalidResponse();
  const mapped: ModelUsage = {};
  for (const [native, unified] of [
    ['prompt_tokens', 'inputTokens'],
    ['completion_tokens', 'outputTokens'],
    ['total_tokens', 'totalTokens'],
  ] as const) {
    const count = value[native];
    if (count !== undefined) {
      if (
        typeof count !== 'number' ||
        !Number.isSafeInteger(count) ||
        count < 0
      )
        return invalidResponse();
      mapped[unified] = count;
    }
  }
  return Object.keys(mapped).length === 0 ? undefined : mapped;
}

export function metadata(
  value: Record<string, unknown>,
  requestedModel: string,
): { id?: string; model: string } {
  if (value.id !== undefined && !nonempty(value.id)) return invalidResponse();
  if (value.model !== undefined && !nonempty(value.model))
    return invalidResponse();
  return {
    ...(typeof value.id === 'string' ? { id: value.id } : {}),
    model: typeof value.model === 'string' ? value.model : requestedModel,
  };
}

function toolCall(value: unknown): ModelToolCall {
  if (
    !record(value) ||
    value.type !== 'function' ||
    !nonempty(value.id) ||
    !record(value.function) ||
    !toolName(value.function.name) ||
    typeof value.function.arguments !== 'string'
  )
    return invalidResponse();
  return {
    id: value.id,
    name: value.function.name,
    argumentsJson: value.function.arguments,
  };
}

export function mapResponse(
  value: unknown,
  requestedModel: string,
): ModelResponse {
  if (record(value) && value.error !== undefined)
    throw failure('provider_error', 'Model provider reported an error.');
  if (
    !record(value) ||
    !Array.isArray(value.choices) ||
    value.choices.length !== 1
  )
    return invalidResponse();
  const choice: unknown = value.choices[0];
  if (
    !record(choice) ||
    (choice.index !== undefined && choice.index !== 0) ||
    !record(choice.message)
  )
    return invalidResponse();
  const source = choice.message;
  if (source.role !== 'assistant') return invalidResponse();
  if (source.function_call != null || source.audio != null)
    throw failure(
      'unsupported_capability',
      'This adapter supports text and function tools only.',
    );
  if (source.content !== null && typeof source.content !== 'string')
    return invalidResponse();
  const message: AssistantMessage = {
    role: 'assistant',
    content: source.content,
  };
  if (source.tool_calls !== undefined) {
    if (!Array.isArray(source.tool_calls)) return invalidResponse();
    const calls = source.tool_calls.map(toolCall);
    if (new Set(calls.map((call) => call.id)).size !== calls.length)
      return invalidResponse();
    if (calls.length > 0) message.toolCalls = calls;
  }
  const reason = finishReason(choice.finish_reason);
  if (reason === 'tool_calls' && !message.toolCalls?.length)
    return invalidResponse();
  const mappedUsage = usage(value.usage);
  return {
    ...metadata(value, requestedModel),
    message,
    finishReason: reason,
    ...(mappedUsage === undefined ? {} : { usage: mappedUsage }),
  };
}
