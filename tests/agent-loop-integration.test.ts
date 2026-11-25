import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLogger,
  DefaultAgentLoop,
  DefaultToolExecutor,
  DefaultToolRegistry,
  ModelError,
  OpenAICompatibleModelClient,
  ToolExecutionError,
  type AgentLoopContext,
  type AgentLoopEvent,
  type AgentLoopResult,
} from '../src/index.ts';

const logger = createLogger({ destination: { write() {} } });

function context(): AgentLoopContext {
  return {
    input: { content: 'current question' },
    context: { messages: [] },
    config: { model: { name: 'offline-model' } },
    control: { signal: new AbortController().signal },
  };
}

function chunk(delta: unknown, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'offline-response',
    model: 'offline-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

function answer(content: string | null): Response {
  return new Response(
    chunk({ role: 'assistant', content }, 'stop') + 'data: [DONE]\n\n',
  );
}

function tools(
  calls: { id: string; name: string; arguments: string }[],
  content: string | null = null,
): Response {
  return new Response(
    chunk({
      role: 'assistant',
      content,
      tool_calls: calls.map((call, index) => ({
        index,
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    }) +
      chunk({}, 'tool_calls') +
      'data: [DONE]\n\n',
  );
}

interface WireRequest {
  model: string;
  messages: Record<string, unknown>[];
  tools?: { function: { name: string } }[];
  stream: boolean;
  temperature?: number;
}

async function collect(events: AsyncIterable<AgentLoopEvent>) {
  const result: AgentLoopEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function end(events: AgentLoopEvent[]): AgentLoopResult {
  assert.equal(events[0]?.type, 'loop_start');
  assert.equal(events.filter((event) => event.type === 'loop_end').length, 1);
  const last = events.at(-1);
  assert.equal(last?.type, 'loop_end');
  if (last?.type !== 'loop_end') throw new Error('Missing loop result');
  return last.result;
}

function registry() {
  const value = new DefaultToolRegistry();
  value.register(
    {
      name: 'echo',
      description: 'Echo a string',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
    (args) => ({ content: `echo:${String(args.text)}` }),
  );
  return value;
}

test('真实Model和Tool Runtime闭环：批次业务错误继续回填，最终正文不重复累加展示增量', async () => {
  const requests: WireRequest[] = [];
  const client = new OpenAICompatibleModelClient({
    baseURL: 'https://provider.invalid/v1',
    logger,
    fetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as WireRequest;
      requests.push(request);
      return requests.length === 1
        ? tools(
            [
              { id: 'bad', name: 'echo', arguments: '{"text":1}' },
              { id: 'good', name: 'echo', arguments: '{"text":"value"}' },
            ],
            'checking tools',
          )
        : answer('final answer');
    },
  });
  const registered = registry();
  const source = context();
  source.context.messages = [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: 'current question' },
    { role: 'assistant', content: 'previous answer' },
  ];
  source.config.model!.parameters = { temperature: 0.2 };
  const before = structuredClone(source.context);
  const events = await collect(
    new DefaultAgentLoop(
      client,
      registered,
      new DefaultToolExecutor(registered, { logger }),
    ).run(source),
  );
  const result = end(events);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, 'final answer');
  assert.equal(
    events
      .filter((event) => event.type === 'output_delta')
      .map((event) => event.content)
      .join(''),
    'checking toolsfinal answer',
  );
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.stream));
  assert.ok(requests.every((request) => request.temperature === 0.2));
  const messages = requests[1]!.messages;
  assert.deepEqual(messages.slice(0, 4), [
    ...before.messages,
    { role: 'user', content: source.input.content },
  ]);
  assert.deepEqual(messages[4], {
    role: 'assistant',
    content: 'checking tools',
    tool_calls: [
      {
        id: 'bad',
        type: 'function',
        function: { name: 'echo', arguments: '{"text":1}' },
      },
      {
        id: 'good',
        type: 'function',
        function: { name: 'echo', arguments: '{"text":"value"}' },
      },
    ],
  });
  assert.equal(messages[5]?.role, 'tool');
  assert.equal(messages[5]?.tool_call_id, 'bad');
  assert.match(String(messages[5]?.content), /^\[Tool execution error\]\n/);
  assert.deepEqual(messages[6], {
    role: 'tool',
    tool_call_id: 'good',
    content: 'echo:value',
  });
  assert.deepEqual(
    events
      .filter((event) => event.type === 'tool_result')
      .map((event) => event.result.status),
    ['error', 'success'],
  );
  assert.equal(result.updatedContext?.messages.length, 8);
  assert.deepEqual(result.updatedContext?.messages.at(-1), {
    role: 'assistant',
    content: 'final answer',
  });
  assert.deepEqual(source.context, before);
});

test('空白工具标识片段经过真实Runtime完成多工具组装、执行和下一轮模型回填', async () => {
  const requests: WireRequest[] = [];
  const executed: string[] = [];
  const client = new OpenAICompatibleModelClient({
    baseURL: 'https://provider.invalid/v1',
    logger,
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as WireRequest);
      if (requests.length === 2) {
        assert.deepEqual(executed, ['北京', '杭州']);
        return answer('两地查询完成');
      }
      assert.equal(requests.length, 1);
      assert.deepEqual(executed, []);
      return new Response(
        chunk({
          role: 'assistant',
          tool_calls: [
            { index: 0, id: null, function: { name: ' \t', arguments: '' } },
          ],
        }) +
          chunk({
            tool_calls: [
              {
                index: 1,
                id: 'call-2',
                function: { name: 'echo', arguments: '{"text":' },
              },
              {
                index: 0,
                id: 'call-1',
                function: { name: 'echo', arguments: '{"text":' },
              },
            ],
          }) +
          chunk({
            tool_calls: [
              { index: 0, id: '', function: { name: '', arguments: '"北京"' } },
              {
                index: 1,
                id: ' \t\n',
                function: { name: '\u00a0', arguments: '"杭州"' },
              },
            ],
          }) +
          chunk({
            tool_calls: [
              { index: 1, id: null, function: { name: null, arguments: '}' } },
              {
                index: 0,
                id: '\u3000',
                function: { name: ' \t\n', arguments: '}' },
              },
            ],
          }) +
          chunk({}, 'tool_calls') +
          'data: [DONE]\n\n',
      );
    },
  });
  const registered = new DefaultToolRegistry();
  registered.register(
    {
      name: 'echo',
      description: 'Echo a string',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
    },
    (args) => {
      const value = String(args.text);
      executed.push(value);
      return { content: `echo:${value}` };
    },
  );
  const events: AgentLoopEvent[] = [];
  const loop = new DefaultAgentLoop(
    client,
    registered,
    new DefaultToolExecutor(registered, { logger }),
  );
  for await (const event of loop.run(context())) {
    if (
      event.type === 'model_event' &&
      event.modelCallIndex === 1 &&
      event.event.type === 'message_end'
    )
      assert.deepEqual(executed, []);
    events.push(event);
  }
  const expectedCalls = [
    { id: 'call-1', name: 'echo', argumentsJson: '{"text":"北京"}' },
    { id: 'call-2', name: 'echo', argumentsJson: '{"text":"杭州"}' },
  ];
  assert.deepEqual(executed, ['北京', '杭州']);
  assert.deepEqual(
    events
      .filter((event) => event.type === 'tool_start')
      .map((event) => event.call),
    expectedCalls,
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === 'tool_result')
      .map((event) => event.result),
    [
      {
        toolCallId: 'call-1',
        name: 'echo',
        status: 'success',
        content: 'echo:北京',
      },
      {
        toolCallId: 'call-2',
        name: 'echo',
        status: 'success',
        content: 'echo:杭州',
      },
    ],
  );
  const deltas = events.flatMap((event) =>
    event.type === 'model_event' && event.event.type === 'tool_call_delta'
      ? [event.event]
      : [],
  );
  assert.equal(deltas.length, 7);
  for (const delta of [deltas[0]!, ...deltas.slice(3)]) {
    assert.equal(Object.hasOwn(delta, 'id'), false);
    assert.equal(Object.hasOwn(delta, 'name'), false);
  }
  assert.deepEqual(requests[1]?.messages, [
    { role: 'user', content: 'current question' },
    {
      role: 'assistant',
      content: null,
      tool_calls: expectedCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.argumentsJson },
      })),
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'echo:北京' },
    { role: 'tool', tool_call_id: 'call-2', content: 'echo:杭州' },
  ]);
  assert.equal(requests.length, 2);
  const result = end(events);
  assert.equal(result.status, 'completed');
  assert.equal(result.output, '两地查询完成');
  assert.deepEqual(result.details, {
    modelCalls: 2,
    modelRetries: 0,
    toolCalls: 2,
  });
  assert.deepEqual(result.updatedContext?.messages[1], {
    role: 'assistant',
    content: null,
    toolCalls: expectedCalls,
  });
  assert.deepEqual(result.updatedContext?.messages.at(-1), {
    role: 'assistant',
    content: '两地查询完成',
  });
});

test('工具可见声明在run内固定，注销产生真实tool_not_found，新工具只在下次run可见', async () => {
  const registered = registry();
  const requests: WireRequest[] = [];
  const client = new OpenAICompatibleModelClient({
    baseURL: 'https://provider.invalid/v1',
    logger,
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as WireRequest);
      return requests.length === 1
        ? tools([{ id: 'removed', name: 'echo', arguments: '{"text":"x"}' }])
        : answer('done');
    },
  });
  const loop = new DefaultAgentLoop(
    client,
    registered,
    new DefaultToolExecutor(registered, { logger }),
  );
  const events: AgentLoopEvent[] = [];
  for await (const event of loop.run(context())) {
    events.push(event);
    if (event.type === 'tool_start') {
      assert.equal(registered.unregister('echo'), true);
      registered.register(
        {
          name: 'new_tool',
          description: 'New',
          parameters: { type: 'object' },
        },
        () => ({ content: 'new' }),
      );
    }
  }
  const failure = events.find((event) => event.type === 'tool_result');
  assert.equal(failure?.type, 'tool_result');
  if (failure?.type === 'tool_result' && failure.result.status === 'error')
    assert.equal(failure.result.error.code, 'tool_not_found');
  else assert.fail('Expected a missing-tool result');
  assert.equal(end(events).status, 'completed');
  assert.deepEqual(
    requests.map((request) => request.tools?.map((tool) => tool.function.name)),
    [['echo'], ['echo']],
  );
  await collect(loop.run(context()));
  assert.deepEqual(
    requests[2]?.tools?.map((tool) => tool.function.name),
    ['new_tool'],
  );
});

test('空assistant权威结果保持null，复用历史时仅请求副本兼容既有Model Runtime', async () => {
  const requests: WireRequest[] = [];
  const client = new OpenAICompatibleModelClient({
    baseURL: 'https://provider.invalid/v1',
    logger,
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as WireRequest);
      return requests.length === 1 ? answer(null) : answer('next answer');
    },
  });
  const registered = registry();
  const loop = new DefaultAgentLoop(
    client,
    registered,
    new DefaultToolExecutor(registered, { logger }),
  );
  const first = end(await collect(loop.run(context())));
  assert.equal(first.output, '');
  assert.deepEqual(first.updatedContext?.messages.at(-1), {
    role: 'assistant',
    content: null,
  });
  const followup = context();
  followup.input.content = 'followup';
  followup.context = first.updatedContext!;
  const second = end(await collect(loop.run(followup)));
  assert.equal(second.output, 'next answer');
  assert.deepEqual(requests[1]?.messages[1], {
    role: 'assistant',
    content: '',
  });
  assert.deepEqual(followup.context.messages[1], {
    role: 'assistant',
    content: null,
  });
  assert.deepEqual(second.updatedContext?.messages[1], {
    role: 'assistant',
    content: null,
  });
});

test('真实HTTP级可重试失败按每轮Context配置重置，不给正常工具往返设总次数上限', async () => {
  let fetches = 0;
  let round = 0;
  const client = new OpenAICompatibleModelClient({
    baseURL: 'https://provider.invalid/v1',
    logger,
    fetch: async () => {
      fetches++;
      if (fetches % 2 === 1)
        return Response.json(
          { error: { message: 'offline retry' } },
          { status: 429 },
        );
      round++;
      return round <= 12
        ? tools([
            {
              id: `round-${round}`,
              name: 'echo',
              arguments: '{"text":"again"}',
            },
          ])
        : answer('finished after twelve tools');
    },
  });
  const source = context();
  source.config.extensions = { defaultAgentLoop: { maxModelRetries: 1 } };
  const registered = registry();
  const events = await collect(
    new DefaultAgentLoop(
      client,
      registered,
      new DefaultToolExecutor(registered, { logger }),
    ).run(source),
  );
  assert.equal(end(events).output, 'finished after twelve tools');
  assert.deepEqual(end(events).details, {
    modelCalls: 26,
    modelRetries: 13,
    toolCalls: 12,
  });
  assert.deepEqual(
    events
      .filter(
        (event) =>
          event.type === 'model_event' && event.event.type === 'message_start',
      )
      .map((event) =>
        event.type === 'model_event' ? event.modelCallIndex : 0,
      ),
    Array.from({ length: 13 }, (_, i) => i + 1),
  );
});

test('真实流已公开事件后的截断不能重试或执行不完整工具，也不产生loop_end', async () => {
  let requests = 0;
  const client = new OpenAICompatibleModelClient({
    baseURL: 'https://provider.invalid/v1',
    logger,
    fetch: async () => {
      requests++;
      return new Response(
        chunk({
          role: 'assistant',
          content: 'partial',
          tool_calls: [
            {
              index: 0,
              id: 'unfinished',
              type: 'function',
              function: { name: 'echo', arguments: '{' },
            },
          ],
        }),
      );
    },
  });
  const registered = registry();
  const events: AgentLoopEvent[] = [];
  await assert.rejects(
    async () => {
      for await (const event of new DefaultAgentLoop(
        client,
        registered,
        new DefaultToolExecutor(registered, { logger }),
      ).run(context()))
        events.push(event);
    },
    (error: unknown) =>
      error instanceof ModelError && error.code === 'invalid_response',
  );
  assert.equal(requests, 1);
  assert.ok(events.some((event) => event.type === 'output_delta'));
  assert.equal(
    events.some(
      (event) => event.type === 'tool_start' || event.type === 'loop_end',
    ),
    false,
  );
});

test(
  'Context单次模型超时传入既有Runtime，取消底层等待且不生成loop_end',
  { timeout: 3000 },
  async () => {
    for (const expose of [false, true]) {
      let requests = 0;
      let cancellations = 0;
      let signal: AbortSignal | null | undefined;
      const client = new OpenAICompatibleModelClient({
        baseURL: 'https://provider.invalid/v1',
        logger,
        fetch: async (_input, init) => {
          requests++;
          signal = init?.signal;
          if (!expose) return new Promise<Response>(() => {});
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  new TextEncoder().encode(
                    chunk({ role: 'assistant', content: 'waiting' }),
                  ),
                );
              },
              cancel() {
                cancellations++;
              },
            }),
          );
        },
      });
      const source = context();
      source.config.extensions = {
        defaultAgentLoop: { maxModelRetries: 0, modelTimeoutMs: 20 },
      };
      const registered = registry();
      const received: AgentLoopEvent[] = [];
      await assert.rejects(
        async () => {
          for await (const event of new DefaultAgentLoop(
            client,
            registered,
            new DefaultToolExecutor(registered, { logger }),
          ).run(source))
            received.push(event);
        },
        (error: unknown) =>
          error instanceof ModelError && error.code === 'timeout',
      );
      assert.equal(requests, 1);
      assert.equal(signal?.aborted, true);
      assert.equal(
        received.some((event) => event.type === 'output_delta'),
        expose,
      );
      assert.equal(
        received.some((event) => event.type === 'loop_end'),
        false,
      );
      if (expose) assert.equal(cancellations, 1);
      assert.equal(source.control.signal.aborted, false);
    }
  },
);

test(
  '真实工具超时作为控制异常传播，不重试、不伪造tool_result或继续后续工具',
  { timeout: 3000 },
  async () => {
    let modelCalls = 0;
    let handlerCalls = 0;
    let toolSignal: AbortSignal | undefined;
    let rejectHandler: ((reason: unknown) => void) | undefined;
    const registered = new DefaultToolRegistry();
    registered.register(
      {
        name: 'slow',
        description: 'Slow tool',
        parameters: { type: 'object' },
      },
      (_args, context) => {
        handlerCalls++;
        toolSignal = context.signal;
        return new Promise((_resolve, reject) => {
          rejectHandler = reject;
        });
      },
    );
    const client = new OpenAICompatibleModelClient({
      baseURL: 'https://provider.invalid/v1',
      logger,
      fetch: async () => {
        modelCalls++;
        return tools([
          { id: 'first', name: 'slow', arguments: '{}' },
          { id: 'second', name: 'slow', arguments: '{}' },
        ]);
      },
    });
    const source = context();
    // Keep short vs hanging handler, but avoid <Ajv/validate under parallel load
    // racing the timer before the handler is entered (handlerCalls would be 0).
    source.config.extensions = { defaultAgentLoop: { toolTimeoutMs: 200 } };
    const received: AgentLoopEvent[] = [];
    try {
      await assert.rejects(
        async () => {
          for await (const event of new DefaultAgentLoop(
            client,
            registered,
            new DefaultToolExecutor(registered, { logger }),
          ).run(source))
            received.push(event);
        },
        (error: unknown) =>
          error instanceof ToolExecutionError && error.code === 'timeout',
      );
      assert.equal(handlerCalls, 1);
      assert.equal(modelCalls, 1);
      assert.equal(toolSignal?.aborted, true);
      assert.deepEqual(
        received
          .filter((event) => event.type === 'tool_start')
          .map((event) => event.call.id),
        ['first'],
      );
      assert.equal(
        received.some(
          (event) => event.type === 'tool_result' || event.type === 'loop_end',
        ),
        false,
      );
      assert.equal(source.control.signal.aborted, false);
    } finally {
      rejectHandler?.(new Error('Late handler rejection must be observed'));
      await new Promise((resolve) => setImmediate(resolve));
    }
  },
);
