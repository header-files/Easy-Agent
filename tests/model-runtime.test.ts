import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ModelError,
  type ModelRequest,
  type ModelStreamEvent,
} from '../src/harness/contracts/model/index.ts';
import { OpenAICompatibleModelClient } from '../src/runtime/model/index.ts';

const request: ModelRequest = {
  model: 'requested',
  messages: [{ role: 'user', content: 'hello' }],
};
const response = (extra: Record<string, unknown> = {}) => ({
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'hi' },
      finish_reason: 'stop',
    },
  ],
  ...extra,
});
const client = (result: unknown, status = 200) =>
  new OpenAICompatibleModelClient({
    fetch: async () => new Response(JSON.stringify(result), { status }),
  });
const code = (expected: string) => (error: unknown) =>
  error instanceof ModelError && error.code === expected;
const collect = async (
  events: AsyncIterable<ModelStreamEvent>,
): Promise<ModelStreamEvent[]> => {
  const result: ModelStreamEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
};
const chunk = (
  delta: Record<string, unknown>,
  finish: string | null = null,
) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
const streamClient = (frames: unknown[]) =>
  new OpenAICompatibleModelClient({
    fetch: async () =>
      new Response(
        frames
          .map(
            (frame) =>
              `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`,
          )
          .join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });

function recording() {
  const sent: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const headers: Headers[] = [];
  const instance = new OpenAICompatibleModelClient({
    apiKey: 'test-key',
    baseURL: 'https://provider.invalid/v1/',
    fetch: async (url, init) => {
      urls.push(String(url));
      headers.push(new Headers(init?.headers));
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(response()));
    },
  });
  return { instance, sent, urls, headers };
}

test('参数统一映射、原生扩展透传和传输配置', async () => {
  const { instance, sent, urls, headers } = recording();
  await instance.generate({
    ...request,
    parameters: {
      temperature: 0.5,
      maxOutputTokens: 23,
      top_p: 0.8,
      seed: 42,
      vendor: { enabled: true },
    },
  });
  assert.deepEqual(sent[0], {
    model: 'requested',
    messages: request.messages,
    stream: false,
    temperature: 0.5,
    max_completion_tokens: 23,
    top_p: 0.8,
    seed: 42,
    vendor: { enabled: true },
  });
  assert.equal(urls[0], 'https://provider.invalid/v1/chat/completions');
  assert.equal(headers[0]?.get('authorization'), 'Bearer test-key');
});

test('兼容旧供应商的输出Token字段配置', async () => {
  let sent: unknown;
  const instance = new OpenAICompatibleModelClient({
    maxTokensField: 'max_tokens',
    fetch: async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(response()));
    },
  });
  await instance.generate({ ...request, parameters: { maxOutputTokens: 9 } });
  assert.deepEqual(sent, { ...request, stream: false, max_tokens: 9 });
});

test('四类消息、工具声明和失败ToolResult准确映射，保留未解析参数', async () => {
  const { instance, sent } = recording();
  const messages: ModelRequest['messages'] = [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'user' },
    {
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'call', name: 'weather', argumentsJson: '{invalid' }],
    },
    { role: 'tool', toolCallId: 'call', content: 'failure', isError: true },
  ];
  await instance.generate({
    ...request,
    messages,
    tools: [
      {
        name: 'weather',
        description: 'Weather',
        parameters: { type: 'object' },
      },
    ],
    toolChoice: 'required',
  });
  assert.deepEqual(sent[0]?.messages, [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'user' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call',
          type: 'function',
          function: { name: 'weather', arguments: '{invalid' },
        },
      ],
    },
    {
      role: 'tool',
      tool_call_id: 'call',
      content: '[Tool execution error]\nfailure',
    },
  ]);
  assert.deepEqual(sent[0]?.tools, [
    {
      type: 'function',
      function: {
        name: 'weather',
        description: 'Weather',
        parameters: { type: 'object' },
      },
    },
  ]);
  assert.equal(sent[0]?.tool_choice, 'required');
  assert.equal(messages[3]?.content, 'failure');
});

test('参数冲突在访问transport前拒绝', async () => {
  const { instance, sent } = recording();
  for (const parameters of [
    { model: 'other' },
    { messages: [] },
    { tools: [] },
    { tool_choice: 'none' },
    { stream: true },
    { maxOutputTokens: 10, max_tokens: 10 },
    { maxOutputTokens: 10, max_completion_tokens: 10 },
    { max_tokens: 1, max_completion_tokens: 2 },
  ])
    await assert.rejects(
      instance.generate({ ...request, parameters }),
      code('invalid_request'),
    );
  assert.equal(sent.length, 0);
});

test('统一参数及请求校验拒绝无效值', async () => {
  const { instance, sent } = recording();
  const invalid: unknown[] = [
    null,
    { ...request, model: ' ' },
    { ...request, messages: [] },
    { ...request, messages: [{ role: 'bad', content: 'hi' }] },
    { ...request, messages: [{ role: 'user', content: [] }] },
    { ...request, messages: [{ role: 'assistant', content: null }] },
    { ...request, messages: [{ role: 'tool', content: 'x', toolCallId: '' }] },
    {
      ...request,
      messages: [
        { role: 'tool', content: 'x', toolCallId: 'id', isError: 'yes' },
      ],
    },
    { ...request, toolChoice: 'required' },
    { ...request, toolChoice: { toString: () => 'auto' } },
    {
      ...request,
      tools: [{ name: 'bad name', description: '', parameters: {} }],
    },
    ...[-1, 2.1, NaN, Infinity, '0.5'].map((temperature) => ({
      ...request,
      parameters: { temperature },
    })),
    ...[0, -1, 1.5, Infinity, '1'].map((maxOutputTokens) => ({
      ...request,
      parameters: { maxOutputTokens },
    })),
    { ...request, parameters: { n: 0 } },
    { ...request, parameters: { stream_options: {} } },
  ];
  for (const value of invalid)
    await assert.rejects(
      instance.generate(value as ModelRequest),
      code('invalid_request'),
    );
  assert.equal(sent.length, 0);
});

test('明确不支持的多候选、旧函数和多模态能力抛出unsupported_capability', async () => {
  for (const parameters of [
    { n: 2 },
    { functions: [] },
    { function_call: 'auto' },
    { audio: {} },
    { modalities: ['audio'] },
  ]) {
    await assert.rejects(
      client(response()).generate({ ...request, parameters }),
      code('unsupported_capability'),
    );
  }
});

test('扩展参数拒绝不能保留语义的非JSON值，原型键仍作为原生参数透传', async () => {
  const { instance, sent } = recording();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  for (const value of [
    undefined,
    NaN,
    Infinity,
    1n,
    () => {},
    new Date(),
    circular,
  ]) {
    await assert.rejects(
      instance.generate({ ...request, parameters: { custom: value } }),
      code('invalid_request'),
    );
  }
  await instance.generate({
    ...request,
    parameters: JSON.parse('{"__proto__":{"custom":true}}') as Record<
      string,
      unknown
    >,
  });
  assert.equal(Object.hasOwn(sent[0] ?? {}, '__proto__'), true);
});

test('Provider实际模型、响应ID、结束原因和部分usage映射', async () => {
  const result = await client(
    response({
      model: 'actual-version',
      id: 'response-id',
      usage: { prompt_tokens: 4, total_tokens: 9 },
    }),
  ).generate(request);
  assert.equal(result.model, 'actual-version');
  assert.equal(result.id, 'response-id');
  assert.deepEqual(result.usage, { inputTokens: 4, totalTokens: 9 });
  assert.equal(result.finishReason, 'stop');
  for (const [native, expected] of [
    ['length', 'length'],
    ['content_filter', 'content_filter'],
    ['new_reason', 'other'],
  ] as const) {
    const result = await client({
      choices: [
        {
          message: { role: 'assistant', content: null },
          finish_reason: native,
        },
      ],
    }).generate(request);
    assert.equal(result.finishReason, expected);
    assert.equal(result.model, 'requested');
    assert.equal(result.usage, undefined);
  }
});

test('非流式直接回答中的 null 工具列表表示没有工具调用', async () => {
  const result = await client({
    choices: [
      {
        message: {
          role: 'assistant',
          content: '200000',
          tool_calls: null,
          function_call: null,
        },
        finish_reason: 'stop',
      },
    ],
  }).generate(request);
  assert.equal(result.message.content, '200000');
  assert.equal(result.message.toolCalls, undefined);
});

test('非流式工具调用保留不合法JSON原文', async () => {
  const result = await client({
    choices: [
      {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'id',
              type: 'function',
              function: { name: 'tool', arguments: '{oops' },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  }).generate(request);
  assert.deepEqual(result.message.toolCalls, [
    { id: 'id', name: 'tool', argumentsJson: '{oops' },
  ]);
});

test('无效响应、缺少工具字段和不一致的工具结束原因均失败', async () => {
  const invalid: unknown[] = [
    {},
    { choices: [] },
    { choices: [{}, {}] },
    {
      choices: [
        { message: { role: 'user', content: 'x' }, finish_reason: 'stop' },
      ],
    },
    {
      choices: [
        { message: { role: 'assistant', content: 2 }, finish_reason: 'stop' },
      ],
    },
    {
      choices: [
        {
          message: { role: 'assistant', content: null },
          finish_reason: 'tool_calls',
        },
      ],
    },
    {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'id', type: 'function', function: { name: 'x' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    {
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'x',
            tool_calls: {},
          },
          finish_reason: 'stop',
        },
      ],
    },
    response({ usage: { prompt_tokens: -1 } }),
    response({ model: '' }),
  ];
  for (const value of invalid)
    await assert.rejects(
      client(value).generate(request),
      code('invalid_response'),
    );
  const badJson = new OpenAICompatibleModelClient({
    fetch: async () => new Response('bad-json'),
  });
  await assert.rejects(badJson.generate(request), code('invalid_response'));
});

test('HTTP错误映射和可重试提示', async () => {
  for (const [status, expected, retryable] of [
    [401, 'authentication', false],
    [403, 'authentication', false],
    [429, 'rate_limit', true],
    [400, 'invalid_request', false],
    [422, 'invalid_request', false],
    [408, 'timeout', true],
    [503, 'provider_error', true],
  ] as const) {
    await assert.rejects(
      client({ error: { message: 'secret' } }, status).generate(request),
      (error: unknown) => {
        assert.ok(error instanceof ModelError);
        assert.equal(error.code, expected);
        assert.equal(error.status, status);
        assert.equal(error.retryable, retryable);
        return true;
      },
    );
  }
  await assert.rejects(
    client({ error: { message: 'secret' } }).generate(request),
    code('provider_error'),
  );
});

test('Provider配置和调用控制校验使用统一错误', async () => {
  for (const config of [
    { baseURL: 'bad' },
    { baseURL: 'ftp://provider.invalid' },
    { baseURL: 'https://user:pass@provider.invalid' },
    { apiKey: 'key\nheader' },
    null,
  ]) {
    assert.throws(
      () => new OpenAICompatibleModelClient(config as never),
      code('invalid_request'),
    );
  }
  for (const timeoutMs of [0, -1, 1.5, NaN, Infinity, 2_147_483_648])
    await assert.rejects(
      client(response()).generate(request, { timeoutMs }),
      code('invalid_request'),
    );
});

test('流式工具字段可以迟到，多工具按照index组装且保留原始参数', async () => {
  const frames = [
    chunk({
      tool_calls: [
        { index: 1, function: { arguments: '{bad' } },
        { index: 0, id: 'id0' },
      ],
    }),
    chunk({
      tool_calls: [
        { index: 1, id: 'id1', function: { name: 'second', arguments: '}' } },
        { index: 0, function: { name: 'first', arguments: '{}' } },
      ],
    }),
    chunk({}, 'tool_calls'),
    '[DONE]',
  ];
  const events = await collect(streamClient(frames).stream(request));
  assert.equal(events[0]?.type, 'message_start');
  const last = events.at(-1);
  assert.equal(last?.type, 'message_end');
  if (last?.type !== 'message_end') throw new Error('missing end');
  assert.deepEqual(last.response.message, {
    role: 'assistant',
    content: null,
    toolCalls: [
      { id: 'id0', name: 'first', argumentsJson: '{}' },
      { id: 'id1', name: 'second', argumentsJson: '{bad}' },
    ],
  });
  assert.equal(
    events.filter((event) => event.type === 'message_start').length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === 'message_end').length,
    1,
  );
});

test('流式工具片段的空白 id 和 name 不覆盖已确定值', async () => {
  const frames = [
    chunk({
      tool_calls: [
        {
          index: 0,
          id: 'call-1',
          type: 'function',
          function: { name: 'get_weather', arguments: '' },
        },
      ],
    }),
    chunk({
      tool_calls: [
        {
          index: 0,
          id: '',
          type: 'function',
          function: { name: '', arguments: '{"city":"北京"}' },
        },
      ],
    }),
    chunk({
      tool_calls: [{ index: 0, id: null, function: { name: null } }],
    }),
    chunk({}, 'tool_calls'),
    '[DONE]',
  ];
  const events = await collect(streamClient(frames).stream(request));
  const deltas = events.filter((event) => event.type === 'tool_call_delta');
  assert.equal(deltas[1]?.type, 'tool_call_delta');
  if (deltas[1]?.type === 'tool_call_delta') {
    assert.equal(deltas[1].id, undefined);
    assert.equal(deltas[1].name, undefined);
    assert.equal(deltas[1].argumentsDelta, '{"city":"北京"}');
  }
  const last = events.at(-1);
  assert.equal(last?.type, 'message_end');
  if (last?.type !== 'message_end') throw new Error('missing end');
  assert.deepEqual(last.response.message.toolCalls, [
    {
      id: 'call-1',
      name: 'get_weather',
      argumentsJson: '{"city":"北京"}',
    },
  ]);
});

test('工具片段的 null 参数和结束块的 null 工具列表仍能组装完整调用', async () => {
  const events = await collect(
    streamClient([
      chunk({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            index: 0,
            id: 'call-add',
            type: 'function',
            function: { name: 'add', arguments: null },
          },
        ],
      }),
      chunk({
        role: null,
        content: null,
        tool_calls: [
          {
            index: 0,
            id: '',
            type: '',
            function: { name: null, arguments: '{"a":100000,"b":100000}' },
          },
        ],
      }),
      chunk(
        { content: null, tool_calls: null, function_call: null },
        'tool_calls',
      ),
      {
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      },
      '[DONE]',
    ]).stream(request),
  );
  const deltas = events.filter((event) => event.type === 'tool_call_delta');
  assert.equal(deltas.length, 2);
  assert.equal(deltas[0]?.type === 'tool_call_delta' && deltas[0].name, 'add');
  assert.equal(
    deltas[1]?.type === 'tool_call_delta' && deltas[1].argumentsDelta,
    '{"a":100000,"b":100000}',
  );
  const last = events.at(-1);
  assert.equal(last?.type, 'message_end');
  if (last?.type !== 'message_end') throw new Error('missing end');
  assert.equal(last.response.message.content, null);
  assert.deepEqual(last.response.message.toolCalls, [
    {
      id: 'call-add',
      name: 'add',
      argumentsJson: '{"a":100000,"b":100000}',
    },
  ]);
  assert.deepEqual(last.response.usage, {
    inputTokens: 10,
    outputTokens: 8,
    totalTokens: 18,
  });
});

const toolFieldPlaceholders = [
  { label: 'null', value: null },
  { label: 'empty string', value: '' },
  { label: 'space', value: ' ' },
  { label: 'tab', value: '\t' },
  { label: 'newline', value: '\r\n' },
  { label: 'Unicode whitespace', value: '\u00a0' },
] as const;

test('已确定工具标识后的各种占位值均省略对应增量字段且不覆盖最终值', async () => {
  for (const { label, value } of toolFieldPlaceholders) {
    const events = await collect(
      streamClient([
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call-stable',
              function: { name: 'stable_tool', arguments: '{"value":' },
            },
          ],
        }),
        chunk({
          tool_calls: [
            { index: 0, id: value, function: { name: value, arguments: '1}' } },
          ],
        }),
        chunk({}, 'tool_calls'),
        '[DONE]',
      ]).stream(request),
    );
    const deltas = events.filter((event) => event.type === 'tool_call_delta');
    assert.equal(deltas.length, 2, label);
    const placeholder = deltas[1]!;
    assert.equal(Object.hasOwn(placeholder, 'id'), false, label);
    assert.equal(Object.hasOwn(placeholder, 'name'), false, label);
    assert.equal(placeholder.argumentsDelta, '1}', label);
    const last = events.at(-1);
    assert.equal(last?.type, 'message_end', label);
    if (last?.type !== 'message_end') throw new Error('missing end');
    assert.deepEqual(
      last.response.message.toolCalls,
      [
        {
          id: 'call-stable',
          name: 'stable_tool',
          argumentsJson: '{"value":1}',
        },
      ],
      label,
    );
  }
});

test('首个工具片段的占位标识可分别在后续片段补齐且参数保持原始拼接', async () => {
  for (const { label, value } of toolFieldPlaceholders) {
    const events = await collect(
      streamClient([
        chunk({
          tool_calls: [
            {
              index: 0,
              id: value,
              function: { name: value, arguments: '{"value":' },
            },
          ],
        }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: 'call-late',
              function: { name: value, arguments: '1' },
            },
          ],
        }),
        chunk({
          tool_calls: [
            {
              index: 0,
              id: value,
              function: { name: 'late_tool', arguments: '}' },
            },
          ],
        }),
        chunk({}, 'tool_calls'),
        '[DONE]',
      ]).stream(request),
    );
    const deltas = events.filter((event) => event.type === 'tool_call_delta');
    assert.equal(deltas.length, 3, label);
    assert.equal(Object.hasOwn(deltas[0]!, 'id'), false, label);
    assert.equal(Object.hasOwn(deltas[0]!, 'name'), false, label);
    assert.equal(deltas[1]!.id, 'call-late', label);
    assert.equal(Object.hasOwn(deltas[1]!, 'name'), false, label);
    assert.equal(Object.hasOwn(deltas[2]!, 'id'), false, label);
    assert.equal(deltas[2]!.name, 'late_tool', label);
    const last = events.at(-1);
    assert.equal(last?.type, 'message_end', label);
    if (last?.type !== 'message_end') throw new Error('missing end');
    assert.deepEqual(
      last.response.message.toolCalls,
      [{ id: 'call-late', name: 'late_tool', argumentsJson: '{"value":1}' }],
      label,
    );
  }
});

test('占位片段不会重置工具标识的一致性校验，非空 id 或 name 冲突仍失败', async () => {
  for (const field of ['id', 'name'] as const) {
    const events: ModelStreamEvent[] = [];
    const frames = [
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'call-stable',
            function: { name: 'stable_tool', arguments: '{' },
          },
        ],
      }),
      chunk({
        tool_calls: [
          { index: 0, id: null, function: { name: ' \t', arguments: '}' } },
        ],
      }),
      chunk({
        tool_calls: [
          {
            index: 0,
            id: field === 'id' ? 'call-conflict' : 'call-stable',
            function: {
              name: field === 'name' ? 'conflict_tool' : 'stable_tool',
            },
          },
        ],
      }),
      chunk({}, 'tool_calls'),
      '[DONE]',
    ];
    await assert.rejects(
      async () => {
        for await (const event of streamClient(frames).stream(request))
          events.push(event);
      },
      code('invalid_response'),
      field,
    );
    assert.equal(
      events.some((event) => event.type === 'tool_call_delta'),
      true,
      field,
    );
    assert.equal(
      events.some((event) => event.type === 'message_end'),
      false,
      field,
    );
  }
});

test('流式拒绝缺失必需工具字段、重复工具ID、未知数据和结束后的增量', async () => {
  const badFrames: unknown[][] = [
    [chunk({ tool_calls: { index: 0 } }), '[DONE]'],
    [
      chunk({
        tool_calls: [
          {
            index: 0,
            id: 'id',
            function: { name: 'x', arguments: { a: 1 } },
          },
        ],
      }),
      chunk({}, 'tool_calls'),
      '[DONE]',
    ],
    [
      chunk({
        tool_calls: [{ index: 0, function: { name: 'x', arguments: '{}' } }],
      }),
      chunk({}, 'tool_calls'),
      '[DONE]',
    ],
    [
      chunk({ tool_calls: [{ index: 0, id: 'id', function: { name: 'x' } }] }),
      chunk({}, 'tool_calls'),
      '[DONE]',
    ],
    [
      chunk({
        tool_calls: [
          { index: 0, id: 'same', function: { name: 'x', arguments: '{}' } },
          { index: 1, id: 'same', function: { name: 'y', arguments: '{}' } },
        ],
      }),
      chunk({}, 'tool_calls'),
      '[DONE]',
    ],
    [chunk({}, 'tool_calls'), '[DONE]'],
    [
      chunk({
        tool_calls: [
          {
            index: 0,
            id: ' ',
            function: { name: 'get_weather', arguments: '{}' },
          },
        ],
      }),
      chunk({}, 'tool_calls'),
      '[DONE]',
    ],
    [chunk({}, 'stop'), chunk({ content: 'late' }), '[DONE]'],
    [{ choices: [] }, '[DONE]'],
    ['not JSON'],
    ['[DONE]'],
  ];
  for (const { value } of toolFieldPlaceholders) {
    for (const missing of ['id', 'name'] as const) {
      badFrames.push([
        chunk({
          tool_calls: [
            {
              index: 0,
              id: missing === 'id' ? value : 'call-present',
              function: {
                name: missing === 'name' ? value : 'present_tool',
                arguments: '{}',
              },
            },
          ],
        }),
        chunk({}, 'tool_calls'),
        '[DONE]',
      ]);
    }
  }
  for (const frames of badFrames)
    await assert.rejects(
      collect(streamClient(frames).stream(request)),
      code('invalid_response'),
    );
});

test('流式默认请求usage，允许原生stream_options关闭', async () => {
  const sent: unknown[] = [];
  const instance = new OpenAICompatibleModelClient({
    fetch: async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(
        `data: ${JSON.stringify(chunk({ content: 'x' }, 'stop'))}\n\ndata: [DONE]\n\n`,
      );
    },
  });
  await collect(instance.stream(request));
  await collect(
    instance.stream({
      ...request,
      parameters: { stream_options: { include_usage: false } },
    }),
  );
  assert.deepEqual(sent, [
    { ...request, stream: true, stream_options: { include_usage: true } },
    { ...request, stream: true, stream_options: { include_usage: false } },
  ]);
  await assert.rejects(
    collect(
      instance.stream({
        ...request,
        parameters: { stream_options: { include_usage: 'yes' } },
      }),
    ),
    code('invalid_request'),
  );
});

test('fallback模型来自已映射的请求快照，不受调用方中途修改影响', async () => {
  const mutable: ModelRequest = {
    model: 'original',
    messages: [{ role: 'user', content: 'hello' }],
  };
  let mode = 'generate';
  const instance = new OpenAICompatibleModelClient({
    fetch: async () => {
      mutable.model = 'changed';
      return mode === 'generate'
        ? new Response(JSON.stringify(response()))
        : new Response(
            `data: ${JSON.stringify(chunk({ content: 'hi' }, 'stop'))}\n\ndata: [DONE]\n\n`,
          );
    },
  });
  assert.equal((await instance.generate(mutable)).model, 'original');
  mutable.model = 'original';
  mode = 'stream';
  const events = await collect(instance.stream(mutable));
  const end = events.at(-1);
  assert.equal(end?.type, 'message_end');
  if (end?.type === 'message_end') assert.equal(end.response.model, 'original');
});

test('transport同步触发取消后返回rejected promise不会泄漏未处理拒绝', async () => {
  const controller = new AbortController();
  const instance = new OpenAICompatibleModelClient({
    fetch: () => {
      controller.abort();
      return Promise.reject(new Error('transport error'));
    },
  });
  await assert.rejects(
    instance.generate(request, { signal: controller.signal }),
    code('aborted'),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('message_end交付前释放底层流和取消控制，即使消费者不再next', async () => {
  let cancelled = false;
  let signal: AbortSignal | null | undefined;
  const instance = new OpenAICompatibleModelClient({
    fetch: async (_url, init) => {
      signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify(chunk({ content: 'hi' }, 'stop'))}\n\ndata: [DONE]\n\n`,
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    },
  });
  const iterator = instance.stream(request)[Symbol.asyncIterator]();
  while (true) {
    const event = await iterator.next();
    if (event.value?.type === 'message_end') break;
    assert.equal(event.done, false);
  }
  assert.equal(cancelled, true);
  assert.equal(signal?.aborted, true);
  await iterator.return?.();
});

test('原生可空n和stream_options原样透传，不被默认值覆盖', async () => {
  const sent: Record<string, unknown>[] = [];
  const instance = new OpenAICompatibleModelClient({
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(body);
      return body.stream
        ? new Response(
            `data: ${JSON.stringify(chunk({ content: 'hi' }, 'stop'))}\n\ndata: [DONE]\n\n`,
          )
        : new Response(JSON.stringify(response()));
    },
  });
  await instance.generate({
    ...request,
    parameters: { n: null, stream_options: null },
  });
  await collect(
    instance.stream({
      ...request,
      parameters: { n: null, stream_options: null },
    }),
  );
  assert.deepEqual(sent, [
    { ...request, stream: false, n: null, stream_options: null },
    { ...request, stream: true, n: null, stream_options: null },
  ]);
});
