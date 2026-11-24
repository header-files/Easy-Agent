import {
  failure,
  nonempty,
  record,
  toolName,
} from '../openai-compatible/errors.ts';

const core = new Set(['model', 'input', 'tools', 'tool_choice', 'stream']);
const unsupported = new Set([
  'previous_response_id',
  'conversation',
  'modalities',
  'audio',
  'n',
]);

function invalid(message: string): never {
  throw failure('invalid_request', message);
}

function jsonCopy(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!record(value) && !Array.isArray(value)) {
    return invalid('Model parameters and schemas must contain JSON values.');
  }
  if (ancestors.has(value)) {
    return invalid('Model request contains circular data.');
  }
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    return invalid('Model request must contain plain JSON objects.');
  }
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

function messages(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) {
    return invalid('Messages must be a non-empty array.');
  }
  const input: Record<string, unknown>[] = [];
  for (const item of value as unknown[]) {
    if (!record(item)) return invalid('Model messages must be objects.');
    switch (item.role) {
      case 'system':
      case 'user':
        if (typeof item.content !== 'string') {
          return invalid('System and user messages require text content.');
        }
        input.push({
          type: 'message',
          role: item.role,
          content: item.content,
        });
        break;
      case 'assistant': {
        if (item.content !== null && typeof item.content !== 'string') {
          return invalid('Assistant content must be text or null.');
        }
        if (typeof item.content === 'string') {
          input.push({
            type: 'message',
            role: 'assistant',
            content: item.content,
          });
        }
        if (item.toolCalls !== undefined) {
          if (!Array.isArray(item.toolCalls)) {
            return invalid('Assistant toolCalls must be an array.');
          }
          const ids = new Set<string>();
          for (const call of item.toolCalls as unknown[]) {
            if (
              !record(call) ||
              !nonempty(call.id) ||
              !toolName(call.name) ||
              typeof call.argumentsJson !== 'string' ||
              ids.has(call.id)
            ) {
              return invalid(
                'Assistant tool calls require unique id, name and argumentsJson.',
              );
            }
            ids.add(call.id);
            input.push({
              type: 'function_call',
              call_id: call.id,
              name: call.name,
              arguments: call.argumentsJson,
            });
          }
        }
        if (item.content === null && !item.toolCalls?.length) {
          return invalid(
            'An assistant message with null content requires tool calls.',
          );
        }
        break;
      }
      case 'tool':
        if (
          !nonempty(item.toolCallId) ||
          typeof item.content !== 'string' ||
          (item.isError !== undefined && typeof item.isError !== 'boolean')
        ) {
          return invalid(
            'Tool results require toolCallId, text content and an optional boolean isError.',
          );
        }
        input.push({
          type: 'function_call_output',
          call_id: item.toolCallId,
          output: item.isError
            ? `[Tool execution error]\n${item.content}`
            : item.content,
        });
        break;
      default:
        return invalid('Unknown model message role.');
    }
  }
  return input;
}

export function mapRequest(
  request: unknown,
  stream: boolean,
): Record<string, unknown> {
  if (!record(request) || !nonempty(request.model)) {
    return invalid('Model must be a non-empty string.');
  }
  const mapped: Record<string, unknown> = {
    model: request.model,
    input: messages(request.messages),
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
        !record(tool.parameters) ||
        names.has(tool.name)
      ) {
        return invalid(
          'Tool definitions require unique valid names, descriptions and JSON Schema objects.',
        );
      }
      names.add(tool.name);
      return {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: jsonCopy(tool.parameters),
        strict: false,
      };
    });
  }
  if (request.toolChoice !== undefined) {
    if (
      typeof request.toolChoice !== 'string' ||
      !['auto', 'none', 'required'].includes(request.toolChoice)
    ) {
      return invalid('Unknown tool choice.');
    }
    if (
      request.toolChoice === 'required' &&
      (!Array.isArray(request.tools) || request.tools.length === 0)
    ) {
      return invalid('Required tool choice requires at least one tool.');
    }
    mapped.tool_choice = request.toolChoice;
  }
  if (request.parameters !== undefined) {
    if (!record(request.parameters)) {
      return invalid('Model parameters must be an object.');
    }
    for (const [key, value] of Object.entries(request.parameters)) {
      if (core.has(key)) {
        return invalid(
          'Model parameters cannot override core protocol fields.',
        );
      }
      if (unsupported.has(key)) {
        throw failure(
          'unsupported_capability',
          'This Responses adapter does not support server-side conversation state, multimodal parameters or multiple candidates.',
        );
      }
      if (
        key === 'temperature' &&
        (typeof value !== 'number' ||
          !Number.isFinite(value) ||
          value < 0 ||
          value > 2)
      ) {
        return invalid('Temperature must be between 0 and 2.');
      }
      if (
        key === 'maxOutputTokens' &&
        (typeof value !== 'number' ||
          !Number.isSafeInteger(value) ||
          value <= 0)
      ) {
        return invalid('maxOutputTokens must be a positive safe integer.');
      }
      if (key !== 'maxOutputTokens') mapped[key] = jsonCopy(value);
    }
    if (
      request.parameters.maxOutputTokens !== undefined &&
      request.parameters.max_output_tokens !== undefined
    ) {
      return invalid('Token limit fields are ambiguous.');
    }
    if (request.parameters.maxOutputTokens !== undefined) {
      mapped.max_output_tokens = request.parameters.maxOutputTokens;
    }
  }
  return mapped;
}
