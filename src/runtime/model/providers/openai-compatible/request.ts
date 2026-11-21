import { failure, nonempty, record, toolName } from './errors.ts';

export type MaxTokensField = 'max_completion_tokens' | 'max_tokens';
const core = new Set(['model', 'messages', 'tools', 'tool_choice', 'stream']);
const unsupported = new Set([
  'functions',
  'function_call',
  'audio',
  'modalities',
]);

function invalid(message: string): never {
  throw failure('invalid_request', message);
}

/** Copy only JSON data, so transport serialization cannot alter caller-owned data. */
function jsonCopy(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!record(value) && !Array.isArray(value))
    return invalid('Model parameters and schemas must contain JSON values.');
  if (ancestors.has(value))
    return invalid('Model request contains circular data.');
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return invalid('Model request must contain plain JSON objects.');
  ancestors.add(value);
  const result = Array.isArray(value)
    ? value.map((entry) => jsonCopy(entry, ancestors))
    : Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          jsonCopy(entry, ancestors),
        ]),
      );
  ancestors.delete(value);
  return result;
}

function calls(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value))
    return invalid('Assistant toolCalls must be an array.');
  const ids = new Set<string>();
  return value.map((call: unknown) => {
    if (
      !record(call) ||
      !nonempty(call.id) ||
      !toolName(call.name) ||
      typeof call.argumentsJson !== 'string'
    )
      return invalid(
        'Assistant tool calls require id, name and argumentsJson.',
      );
    if (ids.has(call.id))
      return invalid('Assistant tool call IDs must be unique.');
    ids.add(call.id);
    return {
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.argumentsJson },
    };
  });
}

function message(value: unknown): Record<string, unknown> {
  if (!record(value)) return invalid('Model messages must be objects.');
  switch (value.role) {
    case 'system':
    case 'user':
      if (typeof value.content !== 'string')
        return invalid('System and user messages require text content.');
      return { role: value.role, content: value.content };
    case 'assistant': {
      if (value.content !== null && typeof value.content !== 'string')
        return invalid('Assistant content must be text or null.');
      const toolCalls =
        value.toolCalls === undefined ? undefined : calls(value.toolCalls);
      if (value.content === null && !toolCalls?.length)
        return invalid(
          'An assistant message with null content requires tool calls.',
        );
      return {
        role: 'assistant',
        content: value.content,
        ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
      };
    }
    case 'tool':
      if (
        !nonempty(value.toolCallId) ||
        typeof value.content !== 'string' ||
        (value.isError !== undefined && typeof value.isError !== 'boolean')
      )
        return invalid(
          'Tool results require toolCallId, text content and an optional boolean isError.',
        );
      return {
        role: 'tool',
        tool_call_id: value.toolCallId,
        content: value.isError
          ? `[Tool execution error]\n${value.content}`
          : value.content,
      };
    default:
      return invalid('Unknown model message role.');
  }
}

export function mapRequest(
  request: unknown,
  stream: boolean,
  maxTokensField: MaxTokensField,
): Record<string, unknown> {
  if (!record(request) || !nonempty(request.model))
    return invalid('Model must be a non-empty string.');
  if (!Array.isArray(request.messages) || request.messages.length === 0)
    return invalid('Messages must be a non-empty array.');
  const mapped: Record<string, unknown> = {
    model: request.model,
    messages: request.messages.map(message),
    stream,
  };
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools))
      return invalid('Tools must be an array.');
    const names = new Set<string>();
    mapped.tools = request.tools.map((tool: unknown) => {
      if (
        !record(tool) ||
        !toolName(tool.name) ||
        typeof tool.description !== 'string' ||
        !record(tool.parameters)
      )
        return invalid(
          'Tool definitions require a valid name, description and JSON Schema object.',
        );
      if (names.has(tool.name)) return invalid('Tool names must be unique.');
      names.add(tool.name);
      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: jsonCopy(tool.parameters),
        },
      };
    });
  }
  if (request.toolChoice !== undefined) {
    if (
      typeof request.toolChoice !== 'string' ||
      !['auto', 'none', 'required'].includes(request.toolChoice)
    )
      return invalid('Unknown tool choice.');
    if (
      request.toolChoice === 'required' &&
      (!Array.isArray(request.tools) || request.tools.length === 0)
    )
      return invalid('Required tool choice requires at least one tool.');
    mapped.tool_choice = request.toolChoice;
  }
  if (request.parameters !== undefined) {
    if (!record(request.parameters))
      return invalid('Model parameters must be an object.');
    const params = request.parameters;
    for (const [key, value] of Object.entries(params)) {
      if (core.has(key))
        return invalid(
          'Model parameters cannot override core protocol fields.',
        );
      if (unsupported.has(key))
        throw failure(
          'unsupported_capability',
          'This adapter supports text and function tools only; legacy functions and multimodal parameters are unsupported.',
        );
      if (
        key === 'temperature' &&
        (typeof value !== 'number' ||
          !Number.isFinite(value) ||
          value < 0 ||
          value > 2)
      )
        return invalid('Temperature must be between 0 and 2.');
      if (
        key === 'maxOutputTokens' &&
        (typeof value !== 'number' ||
          !Number.isSafeInteger(value) ||
          value <= 0)
      )
        return invalid('maxOutputTokens must be a positive safe integer.');
      if (key === 'n' && value !== 1 && value !== null) {
        if (
          typeof value !== 'number' ||
          !Number.isSafeInteger(value) ||
          value <= 0
        )
          return invalid('n must be a positive integer.');
        throw failure(
          'unsupported_capability',
          'Multiple completion choices are unsupported.',
        );
      }
      if (key !== 'maxOutputTokens')
        Object.defineProperty(mapped, key, {
          value: jsonCopy(value),
          enumerable: true,
          configurable: true,
          writable: true,
        });
    }
    if (
      (params.maxOutputTokens !== undefined &&
        (params.max_tokens !== undefined ||
          params.max_completion_tokens !== undefined)) ||
      (params.max_tokens !== undefined &&
        params.max_completion_tokens !== undefined)
    )
      return invalid('Token limit fields are ambiguous.');
    if (params.maxOutputTokens !== undefined)
      mapped[maxTokensField] = params.maxOutputTokens;
    if (params.stream_options !== undefined && params.stream_options !== null) {
      if (
        !stream ||
        !record(params.stream_options) ||
        (params.stream_options.include_usage !== undefined &&
          typeof params.stream_options.include_usage !== 'boolean')
      )
        return invalid('stream_options must be valid streaming options.');
    }
  }
  if (stream && mapped.stream_options === undefined)
    mapped.stream_options = { include_usage: true };
  return mapped;
}
