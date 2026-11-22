import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ModelError,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
} from '../src/harness/contracts/model/index.ts';
import type {
  AgentLoopContext,
  AgentLoopEvent,
} from '../src/harness/contracts/agent-loop/index.ts';
import type {
  ToolCall,
  ToolExecutor,
  ToolRegistry,
} from '../src/harness/contracts/tool/index.ts';
import { DefaultAgentLoop } from '../src/execution/loops/index.ts';

function context(): AgentLoopContext {
  return {
    input: { content: 'new input' },
    context: { messages: [] },
    config: { model: { name: 'test-model' } },
    control: { signal: new AbortController().signal },
  };
}
const calls = [
  { id: 'call-a', name: 'echo', argumentsJson: '{"text":"a"}' },
  { id: 'call-b', name: 'echo', argumentsJson: '{"text":"b"}' },
];
const response = (
  content: string | null,
  finishReason: ModelResponse['finishReason'] = 'stop',
  toolCalls?: ToolCall[],
): ModelResponse => ({
  model: 'test-model',
  message: {
    role: 'assistant',
    content,
    ...(toolCalls === undefined ? {} : { toolCalls }),
  },
  finishReason,
});
async function* stream(value: ModelResponse): AsyncGenerator<ModelStreamEvent> {
  yield { type: 'message_start', model: value.model };
  if (value.message.content)
    yield { type: 'text_delta', text: value.message.content };
  yield { type: 'message_end', response: value };
}
function registry(): ToolRegistry {
  return {
    register() {},
    unregister: () => false,
    get: () => undefined,
    list: () => [
      { name: 'echo', description: 'Echo', parameters: { type: 'object' } },
    ],
  };
}
const executor: ToolExecutor = {
  execute: async (call) => ({
    toolCallId: call.id,
    name: call.name,
    status: 'success',
    content: call.argumentsJson,
  }),
};
function model(
  responses: ModelResponse[],
  observed: ModelRequest[] = [],
): ModelClient {
  return {
    generate() {
      throw new Error('generate must not be called');
    },
    stream(request) {
      observed.push(request);
      const value = responses.shift();
      if (!value) throw new Error('unexpected model call');
      return stream(value);
    },
  };
}
async function collect(
  events: AsyncIterable<AgentLoopEvent>,
): Promise<AgentLoopEvent[]> {
  const result: AgentLoopEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
function end(events: AgentLoopEvent[]) {
  const last = events.at(-1);
  assert.equal(last?.type, 'loop_end');
  if (last?.type !== 'loop_end') throw new Error();
  return last.result;
}

test('无工具普通流按序转发并返回权威文本与完整独立上下文', async () => {
  const source = context();
  source.context.messages = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'prior' },
    { role: 'assistant', content: 'old answer' },
  ];
  const data = { opaque: new Date(), callback: () => 42 };
  source.context.data = data;
  const requests: ModelRequest[] = [];
  const loop = new DefaultAgentLoop(
    model([response('final')], requests),
    registry(),
    executor,
  );
  const events = await collect(loop.run(source));
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'loop_start',
      'model_event',
      'model_event',
      'output_delta',
      'model_event',
      'loop_end',
    ],
  );
  const result = end(events);
  assert.equal(result.status, 'completed');
  if (result.status === 'completed') assert.equal(result.output, 'final');
  assert.deepEqual(result.updatedContext?.messages, [
    ...source.context.messages,
    { role: 'user', content: 'new input' },
    { role: 'assistant', content: 'final' },
  ]);
  assert.equal(result.updatedContext?.data, data);
  assert.equal(source.context.messages.length, 3);
  requests[0]!.messages[0]!.content = 'mutated';
  assert.equal(source.context.messages[0]?.content, 'system');
  assert.equal(result.updatedContext?.messages[0]?.content, 'system');
});

test('多工具严格按返回顺序执行，业务错误仍继续，整批结果回填后再次模型调用', async () => {
  const requests: ModelRequest[] = [];
  const order: string[] = [];
  const tool: ToolExecutor = {
    execute: async (call) => {
      order.push(call.id);
      return call.id === 'call-a'
        ? {
            toolCallId: call.id,
            name: call.name,
            status: 'error',
            content: 'bad arguments',
            error: { code: 'invalid_arguments', message: 'bad arguments' },
          }
        : {
            toolCallId: call.id,
            name: call.name,
            status: 'success',
            content: 'result b',
          };
    },
  };
  const loop = new DefaultAgentLoop(
    model(
      [response('checking', 'tool_calls', calls), response('answer')],
      requests,
    ),
    registry(),
    tool,
  );
  const events = await collect(loop.run(context()));
  assert.deepEqual(order, ['call-a', 'call-b']);
  assert.deepEqual(
    events
      .filter(
        (event) => event.type === 'tool_start' || event.type === 'tool_result',
      )
      .map((event) => event.type),
    ['tool_start', 'tool_result', 'tool_start', 'tool_result'],
  );
  assert.deepEqual(requests[1]?.messages, [
    { role: 'user', content: 'new input' },
    { role: 'assistant', content: 'checking', toolCalls: calls },
    {
      role: 'tool',
      toolCallId: 'call-a',
      content: 'bad arguments',
      isError: true,
    },
    { role: 'tool', toolCallId: 'call-b', content: 'result b', isError: false },
  ]);
  assert.equal(end(events).output, 'answer');
  assert.deepEqual(
    events
      .filter(
        (event) =>
          event.type === 'model_event' && event.event.type === 'message_start',
      )
      .map((event) =>
        event.type === 'model_event' ? event.modelCallIndex : 0,
      ),
    [1, 2],
  );
});

test('可预期停止不把截断工具交互放入复用历史，最终output独立于中间展示', async () => {
  for (const reason of ['length', 'content_filter', 'other'] as const) {
    const events = await collect(
      new DefaultAgentLoop(
        model([response('partial', reason, calls)]),
        registry(),
        executor,
      ).run(context()),
    );
    const result = end(events);
    assert.equal(result.status, 'stopped');
    if (result.status === 'stopped') assert.equal(result.reason, reason);
    assert.equal(result.output, 'partial');
    assert.deepEqual(result.updatedContext?.messages, [
      { role: 'user', content: 'new input' },
    ]);
    assert.equal(
      events.some((event) => event.type === 'tool_start'),
      false,
    );
  }
});

test('先验证整批工具范围，不允许的后一个工具使第一项也不执行', async () => {
  let invoked = 0;
  const tool: ToolExecutor = {
    execute: async () => {
      invoked++;
      throw new Error();
    },
  };
  const events: AgentLoopEvent[] = [];
  const loop = new DefaultAgentLoop(
    model([
      response(null, 'tool_calls', [
        calls[0]!,
        { id: 'other', name: 'not_allowed', argumentsJson: '{}' },
      ]),
    ]),
    registry(),
    tool,
  );
  await assert.rejects(async () => {
    for await (const event of loop.run(context())) events.push(event);
  }, /allowed scope/);
  assert.equal(invoked, 0);
  assert.equal(
    events.some((event) => event.type === 'loop_end'),
    false,
  );
});

test('模型重试只发生在当前尝试尚无对外事件时，索引不因retry改变', async () => {
  let attempts = 0;
  const transient = new ModelError({
    code: 'network',
    message: 'transient',
    retryable: true,
  });
  const client: ModelClient = {
    generate() {
      throw new Error();
    },
    stream() {
      attempts++;
      if (attempts < 3) throw transient;
      return stream(response('ok'));
    },
  };
  const events = await collect(
    new DefaultAgentLoop(client, registry(), executor).run(context()),
  );
  assert.equal(attempts, 3);
  assert.deepEqual(
    events
      .filter((event) => event.type === 'model_event')
      .map((event) =>
        event.type === 'model_event' ? event.modelCallIndex : 0,
      ),
    [1, 1, 1],
  );
  assert.deepEqual(end(events).details, {
    modelCalls: 3,
    modelRetries: 2,
    toolCalls: 0,
  });
  const afterStart: ModelClient = {
    generate() {
      throw new Error();
    },
    async *stream() {
      yield { type: 'message_start', model: 'test' };
      throw transient;
    },
  };
  await assert.rejects(
    collect(
      new DefaultAgentLoop(afterStart, registry(), executor).run(context()),
    ),
    (error: unknown) => error === transient,
  );
});

test('没有隐藏循环上限，正常工具往返超过十次仍完成', async () => {
  const responses = Array.from({ length: 12 }, (_, index) =>
    response(null, 'tool_calls', [{ ...calls[0]!, id: `round-${index}` }]),
  );
  responses.push(response('done'));
  const result = end(
    await collect(
      new DefaultAgentLoop(model(responses), registry(), executor).run(
        context(),
      ),
    ),
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'done');
  assert.equal(result.details?.toolCalls, 12);
  assert.equal(result.details?.modelCalls, 13);
});

test('配置来自Context，允许名单为空不展开全表，错误配置在启动前失败', async () => {
  const requests: ModelRequest[] = [];
  const source = context();
  source.config.tools = { allowedNames: [] };
  source.config.model!.parameters = {
    temperature: 0.4,
    custom: { nested: true },
  };
  source.config.extensions = {
    defaultAgentLoop: {
      maxModelRetries: 0,
      modelTimeoutMs: 1000,
      toolTimeoutMs: 2000,
    },
  };
  await collect(
    new DefaultAgentLoop(
      model([response('ok')], requests),
      registry(),
      executor,
    ).run(source),
  );
  assert.deepEqual(requests[0]?.tools, []);
  assert.deepEqual(requests[0]?.parameters, source.config.model?.parameters);
  for (const policy of [
    { maxModelRetries: -1 },
    { maxModelRetries: null },
    { modelTimeoutMs: 0.5 },
    { toolTimeoutMs: 0 },
  ]) {
    const invalid = context();
    invalid.config.extensions = { defaultAgentLoop: policy };
    await assert.rejects(
      collect(
        new DefaultAgentLoop(model([]), registry(), executor).run(invalid),
      ),
      /context or configuration/,
    );
  }
});

test('无message_end、重复结束、结束后继续事件和无效finish组合不执行工具或loop_end', async () => {
  const ending: ModelStreamEvent = {
    type: 'message_end',
    response: response(null, 'tool_calls', [calls[0]!]),
  };
  const sequences: ModelStreamEvent[][] = [
    [{ type: 'message_start', model: 'test' }],
    [{ type: 'message_start', model: 'test' }, ending, ending],
    [
      { type: 'message_start', model: 'test' },
      ending,
      { type: 'text_delta', text: 'late' },
    ],
    [
      { type: 'message_start', model: 'test' },
      { type: 'message_end', response: response('invalid', 'stop', calls) },
    ],
    [
      { type: 'message_start', model: 'test' },
      { type: 'message_end', response: response(null, 'tool_calls', []) },
    ],
  ];
  for (const sequence of sequences) {
    let executions = 0;
    const observed: AgentLoopEvent[] = [];
    const client: ModelClient = {
      generate() {
        throw new Error();
      },
      async *stream() {
        yield* sequence;
      },
    };
    const tools: ToolExecutor = {
      async execute() {
        executions++;
        throw new Error();
      },
    };
    await assert.rejects(
      async () => {
        for await (const event of new DefaultAgentLoop(
          client,
          registry(),
          tools,
        ).run(context()))
          observed.push(event);
      },
      (error: unknown) =>
        error instanceof ModelError && error.code === 'invalid_response',
    );
    assert.equal(executions, 0);
    assert.equal(
      observed.some((event) => event.type === 'loop_end'),
      false,
    );
  }
});

test('对外事件、能力输入和权威历史不共享可变工具调用/结果引用', async () => {
  const requests: ModelRequest[] = [];
  const originalCall = { ...calls[0]! };
  const client = model(
    [response(null, 'tool_calls', [originalCall]), response('final')],
    requests,
  );
  const tools: ToolExecutor = {
    async execute(call) {
      assert.equal(call.argumentsJson, '{"text":"a"}');
      call.argumentsJson = 'executor mutation';
      return {
        toolCallId: call.id,
        name: call.name,
        status: 'success',
        content: 'real tool result',
      };
    },
  };
  const observed: AgentLoopEvent[] = [];
  for await (const event of new DefaultAgentLoop(client, registry(), tools).run(
    context(),
  )) {
    observed.push(event);
    if (
      event.type === 'model_event' &&
      event.event.type === 'message_end' &&
      event.event.response.message.toolCalls
    )
      event.event.response.message.toolCalls[0]!.argumentsJson =
        'consumer model mutation';
    if (event.type === 'tool_start')
      event.call.argumentsJson = 'consumer start mutation';
    if (event.type === 'tool_result')
      event.result.content = 'consumer result mutation';
  }
  const history = requests[1]!.messages;
  const assistant = history[1];
  assert.equal(assistant?.role, 'assistant');
  if (assistant?.role === 'assistant')
    assert.equal(assistant.toolCalls?.[0]?.argumentsJson, '{"text":"a"}');
  assert.equal(history[2]?.content, 'real tool result');
  assert.equal(originalCall.argumentsJson, '{"text":"a"}');
  assert.equal(
    end(observed).updatedContext?.messages[2]?.content,
    'real tool result',
  );
});

test('每次新的逻辑模型调用重新计算retry预算，显式0和aborted从不重试', async () => {
  let attempts = 0;
  const failure = new ModelError({
    code: 'network',
    message: 'retry me',
    retryable: true,
  });
  const client: ModelClient = {
    generate() {
      throw new Error();
    },
    stream() {
      attempts++;
      if ([1, 2, 4, 5].includes(attempts)) throw failure;
      return stream(
        attempts === 3
          ? response(null, 'tool_calls', [calls[0]!])
          : response('done'),
      );
    },
  };
  const result = end(
    await collect(
      new DefaultAgentLoop(client, registry(), executor).run(context()),
    ),
  );
  assert.equal(attempts, 6);
  assert.deepEqual(result.details, {
    modelCalls: 6,
    modelRetries: 4,
    toolCalls: 1,
  });
  for (const mode of ['zero', 'aborted']) {
    let count = 0;
    const thrown =
      mode === 'zero'
        ? failure
        : new ModelError({
            code: 'aborted',
            message: 'cancelled',
            retryable: true,
          });
    const failing: ModelClient = {
      generate() {
        throw new Error();
      },
      stream() {
        count++;
        throw thrown;
      },
    };
    const source = context();
    if (mode === 'zero')
      source.config.extensions = { defaultAgentLoop: { maxModelRetries: 0 } };
    await assert.rejects(
      collect(new DefaultAgentLoop(failing, registry(), executor).run(source)),
      (error: unknown) => error === thrown,
    );
    assert.equal(count, 1);
  }
});

test('模型流清理抛错或拒绝不覆盖可重试原始错误，也不成为新的重试来源', async () => {
  for (const asynchronous of [false, true]) {
    let attempts = 0;
    const original = new ModelError({
      code: 'network',
      message: 'original failure',
      retryable: true,
    });
    const cleanup = new ModelError({
      code: 'provider_error',
      message: 'cleanup failure',
      retryable: true,
    });
    const client: ModelClient = {
      generate() {
        throw new Error();
      },
      stream() {
        attempts++;
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                return Promise.reject(original);
              },
              return() {
                if (asynchronous) return Promise.reject(cleanup);
                throw cleanup;
              },
            };
          },
        };
      },
    };
    await assert.rejects(
      collect(
        new DefaultAgentLoop(client, registry(), executor).run(context()),
      ),
      (error: unknown) => error === original,
    );
    assert.equal(attempts, 3);
  }
});
