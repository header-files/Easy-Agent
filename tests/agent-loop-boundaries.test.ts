import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DefaultAgentLoop,
  DefaultToolRegistry,
  ModelError,
  type AgentLoopContext,
  type AgentLoopEvent,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ToolExecutor,
} from '../src/index.ts';

const call = { id: 'call', name: 'echo', argumentsJson: '{}' };
function context(): AgentLoopContext {
  return {
    input: { content: 'question' },
    context: { messages: [{ role: 'system', content: 'original system' }] },
    config: { model: { name: 'test' } },
    control: { signal: new AbortController().signal },
  };
}
function response(withTool = false): ModelResponse {
  return {
    model: 'test',
    message: {
      role: 'assistant',
      content: 'authoritative',
      ...(withTool ? { toolCalls: [{ ...call }] } : {}),
    },
    finishReason: withTool ? 'tool_calls' : 'stop',
  };
}
function events(value: ModelResponse): ModelStreamEvent[] {
  return [
    { type: 'message_start', model: 'test' },
    { type: 'text_delta', text: 'display' },
    { type: 'message_end', response: value },
  ];
}
function registered() {
  const registry = new DefaultToolRegistry();
  registry.register(
    { name: 'echo', description: 'Echo', parameters: { type: 'object' } },
    () => ({ content: 'unused' }),
  );
  return registry;
}
const executor: ToolExecutor = {
  execute: async (value) => ({
    toolCallId: value.id,
    name: value.name,
    status: 'success',
    content: 'original result',
  }),
};
async function collect(source: AsyncIterable<AgentLoopEvent>) {
  const received: AgentLoopEvent[] = [];
  for await (const event of source) received.push(event);
  return received;
}

test('缺失或重复message_end、结束后事件或异常都不得执行工具或伪装loop_end，流始终被关闭', async () => {
  const end: ModelStreamEvent = {
    type: 'message_end',
    response: response(true),
  };
  const start: ModelStreamEvent = { type: 'message_start', model: 'test' };
  const failure = new Error('failure after message_end');
  const scenarios = [
    { values: [start] },
    { values: [start, end, end] },
    { values: [start, end, { type: 'text_delta', text: 'late' } as const] },
    { values: [start, end], failure },
    { values: [end] },
  ];
  for (const scenario of scenarios) {
    let closed = 0;
    let toolCalls = 0;
    const received: AgentLoopEvent[] = [];
    const client: ModelClient = {
      generate() {
        throw new Error('Only stream is allowed');
      },
      async *stream() {
        try {
          yield* scenario.values;
          if (scenario.failure) throw scenario.failure;
        } finally {
          closed++;
        }
      },
    };
    const loop = new DefaultAgentLoop(client, registered(), {
      execute: async () => {
        toolCalls++;
        throw new Error('Must not execute');
      },
    });
    await assert.rejects(
      async () => {
        for await (const event of loop.run(context())) received.push(event);
      },
      (error: unknown) =>
        scenario.failure
          ? error === failure
          : error instanceof ModelError && error.code === 'invalid_response',
    );
    assert.equal(toolCalls, 0);
    assert.equal(closed, 1);
    assert.equal(
      received.some((event) => event.type === 'loop_end'),
      false,
    );
  }
});

test('Context策略与重试类别严格生效，重试耗尽抛出最后错误原对象', async () => {
  const transient = (index: number) =>
    new ModelError({
      code: 'network',
      message: `attempt ${index}`,
      retryable: true,
    });
  const scenarios = [
    {
      retries: undefined,
      errors: [transient(1), transient(2), transient(3)],
      expected: 3,
    },
    { retries: 0, errors: [transient(1)], expected: 1 },
    {
      retries: 4,
      errors: [
        new ModelError({
          code: 'invalid_request',
          message: 'invalid',
          retryable: false,
        }),
      ],
      expected: 1,
    },
    {
      retries: 4,
      errors: [
        new ModelError({
          code: 'aborted',
          message: 'cancelled',
          retryable: true,
        }),
      ],
      expected: 1,
    },
    {
      retries: 4,
      errors: [
        Object.assign(new Error('ordinary failure'), { retryable: true }),
      ],
      expected: 1,
    },
  ];
  for (const scenario of scenarios) {
    let attempts = 0;
    const client: ModelClient = {
      generate() {
        throw new Error('Only stream is allowed');
      },
      stream() {
        throw scenario.errors[attempts++];
      },
    };
    const source = context();
    if (scenario.retries !== undefined)
      source.config.extensions = {
        defaultAgentLoop: { maxModelRetries: scenario.retries },
      };
    await assert.rejects(
      collect(new DefaultAgentLoop(client, registered(), executor).run(source)),
      (error: unknown) => error === scenario.errors.at(-1),
    );
    assert.equal(attempts, scenario.expected);
  }
});

test('事件、依赖和调用方的可变对象不能篡改Loop内部消息、调用身份或后续请求', async () => {
  const requests: ModelRequest[] = [];
  const source = context();
  source.config.model!.parameters = { custom: { original: true } };
  const opaqueData = Object.freeze({ callback: () => 'opaque' });
  source.context.data = opaqueData;
  const client: ModelClient = {
    generate() {
      throw new Error('Only stream is allowed');
    },
    async *stream(request) {
      requests.push(structuredClone(request));
      request.messages[0]!.content = 'dependency mutation';
      if (request.tools?.[0])
        request.tools[0].description = 'dependency mutation';
      const value = response(requests.length === 1);
      yield* events(value);
      value.message.content = 'late model mutation';
      if (value.message.toolCalls?.[0])
        value.message.toolCalls[0].name = 'late_mutation';
    },
  };
  const executed: string[] = [];
  const received: AgentLoopEvent[] = [];
  const loop = new DefaultAgentLoop(client, registered(), {
    execute: async (value) => {
      executed.push(value.name);
      value.name = 'executor mutation';
      return {
        toolCallId: call.id,
        name: call.name,
        status: 'success',
        content: 'original result',
      };
    },
  });
  for await (const event of loop.run(source)) {
    received.push(event);
    if (event.type === 'loop_start') {
      source.input.content = 'caller mutation';
      source.context.messages[0]!.content = 'caller mutation';
      source.config.model!.parameters = { changed: true };
    }
    if (event.type === 'model_event' && event.event.type === 'message_end') {
      event.event.response.message.content = 'consumer mutation';
      const visibleCall = event.event.response.message.toolCalls?.[0];
      if (visibleCall) visibleCall.name = 'consumer_mutation';
    }
    if (event.type === 'tool_start') event.call.name = 'consumer_mutation';
    if (event.type === 'tool_result')
      event.result.content = 'consumer mutation';
  }
  const result = received.at(-1);
  assert.equal(result?.type, 'loop_end');
  if (result?.type !== 'loop_end') throw new Error('Missing final result');
  assert.deepEqual(executed, ['echo']);
  assert.equal(result.result.output, 'authoritative');
  assert.strictEqual(result.result.updatedContext?.data, opaqueData);
  assert.deepEqual(requests[1]?.messages, [
    { role: 'system', content: 'original system' },
    { role: 'user', content: 'question' },
    { role: 'assistant', content: 'authoritative', toolCalls: [call] },
    {
      role: 'tool',
      toolCallId: call.id,
      content: 'original result',
      isError: false,
    },
  ]);
  assert.deepEqual(requests[1]?.parameters, { custom: { original: true } });
  assert.equal(requests[1]?.tools?.[0]?.description, 'Echo');
  assert.equal(
    result.result.updatedContext?.messages[0]?.content,
    'original system',
  );
});

test('stop带工具和tool_calls不带工具是协议错误，未知allowlist在任何模型调用前失败', async () => {
  for (const invalid of [
    { ...response(true), finishReason: 'stop' as const },
    { ...response(), finishReason: 'tool_calls' as const },
  ]) {
    const client: ModelClient = {
      generate() {
        throw new Error();
      },
      async *stream() {
        yield* events(invalid);
      },
    };
    await assert.rejects(
      collect(
        new DefaultAgentLoop(client, registered(), executor).run(context()),
      ),
      (error: unknown) =>
        error instanceof ModelError && error.code === 'invalid_response',
    );
  }
  let calls = 0;
  const client: ModelClient = {
    generate() {
      throw new Error();
    },
    async *stream() {
      calls++;
      yield* events(response());
    },
  };
  const source = context();
  source.config.tools = { allowedNames: ['missing'] };
  await assert.rejects(
    collect(new DefaultAgentLoop(client, registered(), executor).run(source)),
    /not registered/,
  );
  assert.equal(calls, 0);
});
