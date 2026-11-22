import {
  ModelError,
  type ModelMessage,
  type ModelResponse,
  type ModelStreamEvent,
  type ModelToolCall,
} from '../../harness/contracts/model/index.ts';
import type {
  ToolCall,
  ToolResult,
} from '../../harness/contracts/tool/index.ts';

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
export function toolName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
}
export function invalidResponse(): never {
  throw new ModelError({
    code: 'invalid_response',
    message: 'Model stream violated the response contract.',
    retryable: false,
  });
}
export function invalidContext(): never {
  throw new Error('Invalid DefaultAgentLoop context or configuration.');
}

/** Model-bound snapshots contain only JSON data, without executing serializers. */
export function copyData(
  value: unknown,
  ancestors = new Set<object>(),
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!object(value) && !Array.isArray(value)) return invalidContext();
  if (ancestors.has(value)) return invalidContext();
  if (
    !Array.isArray(value) &&
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return invalidContext();
  ancestors.add(value);
  try {
    const entries: Record<string, PropertyDescriptor> =
      Object.getOwnPropertyDescriptors(value);
    if (Array.isArray(value)) {
      const length: unknown = entries.length?.value;
      if (typeof length !== 'number') return invalidContext();
      return Array.from({ length }, (_, index) => {
        const entry = entries[String(index)];
        if (!entry || !('value' in entry)) return invalidContext();
        return copyData(entry.value, ancestors);
      });
    }
    return Object.fromEntries(
      Object.entries(entries)
        .filter(([, entry]) => entry.enumerable)
        .map(([key, entry]) => {
          if (!('value' in entry)) return invalidContext();
          return [key, copyData(entry.value, ancestors)];
        }),
    );
  } finally {
    ancestors.delete(value);
  }
}

export function copyCalls(
  value: unknown,
  invalid: () => never = invalidResponse,
): ModelToolCall[] {
  if (!Array.isArray(value)) return invalid();
  const ids = new Set<string>();
  return value.map((call: unknown) => {
    if (!object(call)) return invalid();
    const { id, name, argumentsJson } = call;
    if (
      !text(id) ||
      !toolName(name) ||
      typeof argumentsJson !== 'string' ||
      ids.has(id)
    )
      return invalid();
    ids.add(id);
    return { id, name, argumentsJson };
  });
}

export function copyMessage(
  value: unknown,
  invalid: () => never = invalidResponse,
): ModelMessage {
  if (!object(value)) return invalid();
  const { role, content } = value;
  if (role === 'system' || role === 'user') {
    if (typeof content !== 'string') return invalid();
    return { role, content };
  }
  if (role === 'assistant') {
    if (content !== null && typeof content !== 'string') return invalid();
    const rawCalls = value.toolCalls;
    const toolCalls =
      rawCalls === undefined ? undefined : copyCalls(rawCalls, invalid);
    return { role, content, ...(toolCalls === undefined ? {} : { toolCalls }) };
  }
  if (role === 'tool') {
    const { toolCallId, isError } = value;
    if (
      !text(toolCallId) ||
      typeof content !== 'string' ||
      (isError !== undefined && typeof isError !== 'boolean')
    )
      return invalid();
    return {
      role,
      toolCallId,
      content,
      ...(isError === undefined ? {} : { isError }),
    };
  }
  return invalid();
}

export function copyHistory(value: unknown): ModelMessage[] {
  if (!Array.isArray(value)) return invalidContext();
  const result = value.map((message: unknown) =>
    copyMessage(message, invalidContext),
  );
  const pending = new Set<string>();
  for (const message of result) {
    if (message.role === 'tool') {
      if (!pending.delete(message.toolCallId)) return invalidContext();
    } else {
      if (pending.size) return invalidContext();
      if (message.role === 'assistant')
        for (const call of message.toolCalls ?? []) pending.add(call.id);
    }
  }
  if (pending.size) return invalidContext();
  return result;
}

export function copyResponse(value: unknown): ModelResponse {
  if (!object(value)) return invalidResponse();
  const { id, model, finishReason } = value;
  if (
    !text(model) ||
    (id !== undefined && !text(id)) ||
    typeof finishReason !== 'string' ||
    !['stop', 'tool_calls', 'length', 'content_filter', 'other'].includes(
      finishReason,
    )
  )
    return invalidResponse();
  const message = copyMessage(value.message);
  if (message.role !== 'assistant') return invalidResponse();
  let usage: ModelResponse['usage'];
  const rawUsage = value.usage;
  if (rawUsage !== undefined) {
    if (!object(rawUsage)) return invalidResponse();
    usage = {};
    for (const field of [
      'inputTokens',
      'outputTokens',
      'totalTokens',
    ] as const) {
      const count = rawUsage[field];
      if (count !== undefined) {
        if (
          typeof count !== 'number' ||
          !Number.isSafeInteger(count) ||
          count < 0
        )
          return invalidResponse();
        usage[field] = count;
      }
    }
  }
  return {
    ...(id === undefined ? {} : { id }),
    model,
    message,
    finishReason: finishReason as ModelResponse['finishReason'],
    ...(usage === undefined ? {} : { usage }),
  };
}

export function copyEvent(value: unknown): ModelStreamEvent {
  if (!object(value)) return invalidResponse();
  switch (value.type) {
    case 'message_start': {
      const { model, id } = value;
      if (!text(model) || (id !== undefined && !text(id)))
        return invalidResponse();
      return {
        type: 'message_start',
        model,
        ...(id === undefined ? {} : { id }),
      };
    }
    case 'text_delta': {
      const delta = value.text;
      if (typeof delta !== 'string') return invalidResponse();
      return { type: 'text_delta', text: delta };
    }
    case 'tool_call_delta': {
      const { index, id, name, argumentsDelta } = value;
      if (
        typeof index !== 'number' ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        (id !== undefined && !text(id)) ||
        (name !== undefined && !toolName(name)) ||
        (argumentsDelta !== undefined && typeof argumentsDelta !== 'string')
      )
        return invalidResponse();
      return {
        type: 'tool_call_delta',
        index,
        ...(id === undefined ? {} : { id }),
        ...(name === undefined ? {} : { name }),
        ...(argumentsDelta === undefined ? {} : { argumentsDelta }),
      };
    }
    case 'message_end':
      return { type: 'message_end', response: copyResponse(value.response) };
    default:
      return invalidResponse();
  }
}

export function copyToolResult(value: unknown, call: ToolCall): ToolResult {
  if (!object(value))
    throw new Error('Tool executor violated the result contract.');
  const { toolCallId, name, content, status, error } = value;
  if (
    toolCallId !== call.id ||
    name !== call.name ||
    typeof content !== 'string'
  )
    throw new Error('Tool executor violated the result contract.');
  if (status === 'success') return { toolCallId, name, status, content };
  if (status !== 'error' || !object(error))
    throw new Error('Tool executor violated the result contract.');
  const { code, message } = error;
  if (
    typeof code !== 'string' ||
    !['tool_not_found', 'invalid_arguments', 'execution_failed'].includes(
      code,
    ) ||
    typeof message !== 'string'
  )
    throw new Error('Tool executor violated the result contract.');
  return {
    toolCallId,
    name,
    status,
    content,
    error: {
      code: code as 'tool_not_found' | 'invalid_arguments' | 'execution_failed',
      message,
    },
  };
}
