import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelError } from '../src/harness/contracts/model/index.ts';
import type {
  ModelClient,
  ModelMessage,
  ModelParameters,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ModelToolCall,
} from '../src/harness/contracts/model/index.ts';

const toolCall: ModelToolCall = {
  id: 'call_1',
  name: 'lookup',
  argumentsJson: '{unfinished',
};

test('消息联合按 role 收窄，工具参数与工具失败语义保持独立', () => {
  const messages: ModelMessage[] = [
    { role: 'system', content: 'Help the user.' },
    { role: 'user', content: 'Find a record.' },
    { role: 'assistant', content: null, toolCalls: [toolCall] },
    {
      role: 'tool',
      toolCallId: toolCall.id,
      content: 'Record missing',
      isError: true,
    },
  ];
  const identifiers = messages.flatMap((message) => {
    switch (message.role) {
      case 'system':
      case 'user':
        return [message.content];
      case 'assistant':
        return message.toolCalls?.map((call) => call.argumentsJson) ?? [];
      case 'tool':
        return [message.toolCallId, String(message.isError)];
      default: {
        const exhaustive: never = message;
        return exhaustive;
      }
    }
  });

  assert.deepEqual(identifiers, [
    'Help the user.',
    'Find a record.',
    '{unfinished',
    'call_1',
    'true',
  ]);
});

test('静态契约拒绝错误消息角色、非文本用户消息和缺失的工具关联', () => {
  // These assignments are checked by tsc, alongside all executable tests.
  type Assignable<From, To> = [From] extends [To] ? true : false;
  const checks: [
    Assignable<{ role: 'developer'; content: string }, ModelMessage>,
    Assignable<{ role: 'user'; content: null }, ModelMessage>,
    Assignable<{ role: 'tool'; content: string }, ModelMessage>,
    Assignable<
      { role: 'assistant'; content: null; toolCalls: ModelToolCall[] },
      ModelMessage
    >,
    Assignable<{ temperature: string }, ModelParameters>,
  ] = [false, false, false, true, false];
  assert.deepEqual(checks, [false, false, false, true, false]);
});

test('统一参数与 Provider 原生扩展共存于 parameters', () => {
  const request: ModelRequest = {
    model: 'example-model',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [
      {
        name: 'lookup',
        description: 'Find a record',
        parameters: { type: 'object' },
      },
    ],
    toolChoice: 'auto',
    parameters: {
      temperature: 0.7,
      maxOutputTokens: 2048,
      top_p: 0.9,
      seed: 42,
      custom_parameter: { enabled: true },
    },
  };

  assert.equal(request.parameters?.maxOutputTokens, 2048);
  assert.deepEqual(request.parameters?.custom_parameter, { enabled: true });
});

test('ModelClient 支持结构化替代实现及独立的 Promise / AsyncIterable 返回值', async () => {
  const request: ModelRequest = {
    model: 'contract-model',
    messages: [{ role: 'user', content: 'hello' }],
  };
  const response: ModelResponse = {
    model: request.model,
    message: { role: 'assistant', content: 'hello' },
    finishReason: 'stop',
  };

  class FixedClient implements ModelClient {
    async generate(): Promise<ModelResponse> {
      return response;
    }

    async *stream(): AsyncIterable<ModelStreamEvent> {
      yield { type: 'message_start', model: response.model };
      yield { type: 'text_delta', text: 'hello' };
      yield { type: 'message_end', response };
    }
  }

  const createClient = (): ModelClient => ({
    generate: async () => response,
    stream: async function* () {
      yield { type: 'message_start', model: response.model };
      yield { type: 'message_end', response };
    },
  });

  for (const client of [
    new FixedClient(),
    createClient(),
  ] satisfies ModelClient[]) {
    const generated: Promise<ModelResponse> = client.generate(request);
    const events: ModelStreamEvent[] = [];
    for await (const event of client.stream(request)) events.push(event);
    assert.equal(await generated, response);
    assert.equal(events[0]?.type, 'message_start');
    const lastEvent = events.at(-1);
    assert.equal(lastEvent?.type, 'message_end');
    if (lastEvent?.type === 'message_end')
      assert.equal(lastEvent.response, response);
  }
});

test('ModelError 保留统一错误信息、可选状态及标准 Error cause', () => {
  const cause = new Error('internal transport cause');
  const error = new ModelError(
    {
      code: 'rate_limit',
      message: 'Provider rate limit exceeded.',
      retryable: true,
      status: 429,
    },
    { cause },
  );

  assert.ok(error instanceof Error);
  assert.equal(error.name, 'ModelError');
  assert.equal(error.message, 'Provider rate limit exceeded.');
  assert.equal(error.code, 'rate_limit');
  assert.equal(error.retryable, true);
  assert.equal(error.status, 429);
  assert.equal(error.cause, cause);
  const withoutStatus = new ModelError({
    code: 'aborted',
    message: 'Model request aborted.',
    retryable: false,
  });
  assert.equal(withoutStatus.status, undefined);
  assert.equal(withoutStatus.cause, undefined);
});
