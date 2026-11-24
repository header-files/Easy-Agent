import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ModelError,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
} from '../src/harness/contracts/model/index.ts';
import { OpenAICompatibleModelClient } from '../src/runtime/model/index.ts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function request(model: string, temperature = 0.5): ModelRequest {
  return {
    model,
    messages: [{ role: 'user', content: `question-${model}` }],
    parameters: { temperature, seed: model.length, custom: { tag: model } },
  };
}

function reply(model: string, text = `answer-${model}`): Response {
  return Response.json({
    id: `id-${model}`,
    model: `actual-${model}`,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: text },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
  });
}

function frame(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function chunk(model: string, delta: unknown, finish: string | null = null) {
  return {
    id: `id-${model}`,
    model: `actual-${model}`,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function feed() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancellations = 0;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel() {
      cancellations += 1;
    },
  });
  return {
    response: new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    }),
    write(text: string) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    close() {
      controller.close();
    },
    get cancellations() {
      return cancellations;
    },
  };
}

async function collect(events: AsyncIterable<ModelStreamEvent>) {
  const result: ModelStreamEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function end(events: ModelStreamEvent[]): ModelResponse {
  assert.equal(
    events.filter((event) => event.type === 'message_start').length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === 'message_end').length,
    1,
  );
  assert.equal(events[0]?.type, 'message_start');
  const last = events.at(-1);
  assert.equal(last?.type, 'message_end');
  if (last?.type !== 'message_end') throw new Error('Missing final response');
  return last.response;
}

function errorCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ModelError);
    assert.equal(error.code, code);
    return true;
  };
}

test(
  '单实例 generate 真正重叠，乱序完成并保留各自参数和原始请求',
  { timeout: 3000 },
  async () => {
    const arrived = deferred<void>();
    const pending = new Map<string, ReturnType<typeof deferred<Response>>>();
    const received = new Map<string, Record<string, unknown>>();
    const client = new OpenAICompatibleModelClient({
      baseURL: 'https://model.invalid/v1/',
      apiKey: 'test-only-key',
      fetch: async (input, init) => {
        assert.equal(
          String(input),
          'https://model.invalid/v1/chat/completions',
        );
        assert.equal(
          new Headers(init?.headers).get('authorization'),
          'Bearer test-only-key',
        );
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const model = String(body.model);
        received.set(model, body);
        const gate = deferred<Response>();
        pending.set(model, gate);
        if (pending.size === 3) arrived.resolve();
        return gate.promise;
      },
    });
    const requests = ['a', 'bb', 'ccc'].map((model, i) =>
      request(model, i / 10),
    );
    const originals = structuredClone(requests);
    const tasks = requests.map((value) => client.generate(value));
    await arrived.promise;
    for (const model of ['ccc', 'a', 'bb'])
      pending.get(model)!.resolve(reply(model));
    const responses = await Promise.all(tasks);
    assert.deepEqual(
      responses.map((value) => value.message.content),
      ['answer-a', 'answer-bb', 'answer-ccc'],
    );
    assert.deepEqual(
      responses.map((value) => value.model),
      ['actual-a', 'actual-bb', 'actual-ccc'],
    );
    requests.forEach((value, i) => {
      const actual = received.get(value.model)!;
      assert.equal(actual.temperature, i / 10);
      assert.equal(actual.seed, value.model.length);
      assert.deepEqual(actual.custom, { tag: value.model });
      assert.deepEqual(actual.messages, value.messages);
    });
    assert.deepEqual(requests, originals);
  },
);

test(
  '两个 stream 与 generate 混合并发，相同工具 ID/index 不交叉，usage 尾块保留',
  { timeout: 3000 },
  async () => {
    const arrived = deferred<void>();
    const streams = new Map([
      ['a', feed()],
      ['b', feed()],
    ]);
    const generateGate = deferred<Response>();
    let started = 0;
    const client = new OpenAICompatibleModelClient({
      baseURL: 'https://provider.invalid/v1',
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as {
          model: string;
          stream: boolean;
        };
        started += 1;
        if (started === 3) arrived.resolve();
        if (!body.stream) return generateGate.promise;
        return streams.get(body.model)!.response;
      },
    });
    const a = collect(client.stream(request('a')));
    const b = collect(client.stream(request('b')));
    const c = client.generate(request('c'));
    await arrived.promise;
    for (const model of ['b', 'a']) {
      streams.get(model)!.write(
        frame(
          chunk(model, {
            role: 'assistant',
            content: model,
            tool_calls: [
              {
                index: 0,
                id: 'same-id',
                type: 'function',
                function: { name: `tool_${model}`, arguments: '{' },
              },
            ],
          }),
        ),
      );
    }
    generateGate.resolve(reply('c'));
    for (const model of ['a', 'b']) {
      const stream = streams.get(model)!;
      stream.write(
        frame(
          chunk(model, {
            content: `-${model}`,
            tool_calls: [
              { index: 0, function: { arguments: `"tag":"${model}"}` } },
            ],
          }),
        ),
      );
      stream.write(frame(chunk(model, {}, 'tool_calls')));
      stream.write(
        frame({
          model: `actual-${model}`,
          choices: [],
          usage: { prompt_tokens: 2, completion_tokens: 4, total_tokens: 6 },
        }),
      );
      stream.write('data: [DONE]\n\n');
      stream.close();
    }
    const [eventsA, eventsB, resultC] = await Promise.all([a, b, c]);
    for (const [model, events] of [
      ['a', eventsA],
      ['b', eventsB],
    ] as const) {
      const result = end(events);
      assert.equal(result.message.content, `${model}-${model}`);
      assert.deepEqual(result.message.toolCalls, [
        {
          id: 'same-id',
          name: `tool_${model}`,
          argumentsJson: `{"tag":"${model}"}`,
        },
      ]);
      assert.deepEqual(result.usage, {
        inputTokens: 2,
        outputTokens: 4,
        totalTokens: 6,
      });
      assert.equal(result.finishReason, 'tool_calls');
    }
    assert.equal(resultC.message.content, 'answer-c');
  },
);

test(
  '取消一个 generate 不影响同实例其他请求和后续复用',
  { timeout: 3000 },
  async () => {
    const arrived = deferred<void>();
    const other = deferred<Response>();
    const controller = new AbortController();
    let count = 0;
    let abortedSignal: AbortSignal | null | undefined;
    const client = new OpenAICompatibleModelClient({
      baseURL: 'https://provider.invalid/v1',
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        count += 1;
        if (count === 2) arrived.resolve();
        if (body.model === 'abort') {
          abortedSignal = init?.signal;
          return new Promise<Response>(() => {});
        }
        if (body.model === 'other') return other.promise;
        return reply(body.model);
      },
    });
    const cancelled = assert.rejects(
      client.generate(request('abort'), { signal: controller.signal }),
      errorCode('aborted'),
    );
    const survivor = client.generate(request('other'));
    await arrived.promise;
    controller.abort(new Error('secret cancellation reason'));
    await cancelled;
    assert.equal(abortedSignal?.aborted, true);
    other.resolve(reply('other'));
    assert.equal((await survivor).message.content, 'answer-other');
    assert.equal(
      (await client.generate(request('reuse'))).message.content,
      'answer-reuse',
    );
  },
);

test('单请求无效响应和网络错误不污染并发成功请求', async () => {
  const client = new OpenAICompatibleModelClient({
    baseURL: 'https://provider.invalid/v1',
    fetch: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { model: string };
      if (body.model === 'network')
        throw new TypeError('Authorization: Bearer secret-key');
      if (body.model === 'invalid') return Response.json({ choices: [] });
      return reply(body.model);
    },
  });
  const [good] = await Promise.all([
    client.generate(request('good')),
    assert.rejects(client.generate(request('network')), errorCode('network')),
    assert.rejects(
      client.generate(request('invalid')),
      errorCode('invalid_response'),
    ),
  ]);
  assert.equal(good.message.content, 'answer-good');
});

test('SSE 逐字节分片、UTF8、CRLF、注释和多 data 行经过完整客户端转换', async () => {
  const raw =
    ': keepalive\r\n\r\n' +
    'event: message\r\ndata: ' +
    JSON.stringify(
      chunk('utf8', { role: 'assistant', content: '你好🌏' }),
    ).replace(',"choices"', ',\r\ndata: "choices"') +
    '\r\n\r\n' +
    frame(chunk('utf8', {}, 'stop')).replaceAll('\n', '\r\n') +
    'data: [DONE]\r\n\r\n';
  const bytes = new TextEncoder().encode(raw);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const value of bytes) controller.enqueue(new Uint8Array([value]));
      controller.close();
    },
  });
  const client = new OpenAICompatibleModelClient({
    baseURL: 'https://provider.invalid/v1',
    fetch: async () => new Response(body),
  });
  const events = await collect(client.stream(request('utf8')));
  assert.equal(end(events).message.content, '你好🌏');
  assert.deepEqual(
    events.filter((value) => value.type === 'text_delta'),
    [{ type: 'text_delta', text: '你好🌏' }],
  );
});

test('stream 懒执行，开始消费才启动 timeout；提前 break 释放底层连接', async () => {
  let calls = 0;
  const stream = feed();
  let signal: AbortSignal | null | undefined;
  const client = new OpenAICompatibleModelClient({
    baseURL: 'https://provider.invalid/v1',
    fetch: async (_input, init) => {
      calls += 1;
      signal = init?.signal;
      return stream.response;
    },
  });
  const iterable = client.stream(request('lazy'), { timeoutMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 0);
  stream.write(frame(chunk('lazy', { role: 'assistant', content: 'first' })));
  for await (const event of iterable) {
    if (event.type === 'text_delta') break;
  }
  assert.equal(calls, 1);
  assert.equal(stream.cancellations, 1);
  assert.equal(signal?.aborted, true);
});

test(
  '流读取期间 timeout 覆盖响应体，其他流仍正常完成',
  { timeout: 3000 },
  async () => {
    const slow = feed();
    const healthy = feed();
    const client = new OpenAICompatibleModelClient({
      baseURL: 'https://provider.invalid/v1',
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body)) as { model: string };
        return body.model === 'slow' ? slow.response : healthy.response;
      },
    });
    slow.write(frame(chunk('slow', { content: 'partial' })));
    const seen: ModelStreamEvent[] = [];
    const slowTask = assert.rejects(
      (async () => {
        for await (const event of client.stream(request('slow'), {
          timeoutMs: 25,
        }))
          seen.push(event);
      })(),
      errorCode('timeout'),
    );
    const healthyTask = collect(client.stream(request('healthy')));
    await slowTask;
    healthy.write(
      frame(chunk('healthy', { content: 'ok' })) +
        frame(chunk('healthy', {}, 'stop')) +
        'data: [DONE]\n\n',
    );
    healthy.close();
    assert.equal(end(await healthyTask).message.content, 'ok');
    assert.equal(
      seen.some((event) => event.type === 'message_end'),
      false,
    );
    assert.equal(slow.cancellations, 1);
  },
);

test(
  'generate 超时覆盖 JSON 响应体读取并取消 body',
  { timeout: 3000 },
  async () => {
    const stream = feed();
    stream.write('{"choices":');
    const client = new OpenAICompatibleModelClient({
      baseURL: 'https://provider.invalid/v1',
      fetch: async () => stream.response,
    });
    await assert.rejects(
      client.generate(request('body'), { timeoutMs: 20 }),
      errorCode('timeout'),
    );
    assert.equal(stream.cancellations, 1);
  },
);

test(
  '流式主动取消与 timeout 区分，取消不会产生 message_end',
  { timeout: 3000 },
  async () => {
    const stream = feed();
    const controller = new AbortController();
    const client = new OpenAICompatibleModelClient({
      baseURL: 'https://provider.invalid/v1',
      fetch: async () => stream.response,
    });
    const seen: ModelStreamEvent[] = [];
    stream.write(frame(chunk('abort-stream', { content: 'partial' })));
    await assert.rejects(
      (async () => {
        for await (const event of client.stream(request('abort-stream'), {
          signal: controller.signal,
          timeoutMs: 1000,
        })) {
          seen.push(event);
          if (event.type === 'text_delta') controller.abort();
        }
      })(),
      errorCode('aborted'),
    );
    assert.equal(
      seen.some((event) => event.type === 'message_end'),
      false,
    );
    assert.equal(stream.cancellations, 1);
  },
);

test('已取消请求不会访问 transport，配置不从环境隐式读取', async () => {
  let calls = 0;
  const controller = new AbortController();
  controller.abort();
  const client = new OpenAICompatibleModelClient({
    baseURL: 'https://provider.invalid/v1',
    fetch: async () => {
      calls += 1;
      return reply('unused');
    },
  });
  await assert.rejects(
    client.generate(request('unused'), { signal: controller.signal }),
    errorCode('aborted'),
  );
  await assert.rejects(
    collect(client.stream(request('unused'), { signal: controller.signal })),
    errorCode('aborted'),
  );
  assert.equal(calls, 0);
});

test('流式截断、错误帧、工具字段冲突均抛出统一错误，不输出成功结束', async () => {
  const scenarios = [
    frame(chunk('bad', { content: 'partial' })),
    frame(chunk('bad', { content: 'partial' })) +
      frame({
        error: { message: 'secret-provider-message', type: 'server_error' },
      }),
    frame(
      chunk('bad', {
        tool_calls: [
          { index: 0, id: 'one', function: { name: 'tool', arguments: '{}' } },
        ],
      }),
    ) +
      frame(chunk('bad', { tool_calls: [{ index: 0, id: 'different' }] })) +
      frame(chunk('bad', {}, 'tool_calls')) +
      'data: [DONE]\n\n',
    frame(
      chunk('bad', {
        tool_calls: [{ index: 0, function: { arguments: '{}' } }],
      }),
    ) +
      frame(chunk('bad', {}, 'tool_calls')) +
      'data: [DONE]\n\n',
  ];
  for (const [index, raw] of scenarios.entries()) {
    const client = new OpenAICompatibleModelClient({
      baseURL: 'https://provider.invalid/v1',
      fetch: async () => new Response(raw),
    });
    const seen: ModelStreamEvent[] = [];
    await assert.rejects(
      (async () => {
        for await (const event of client.stream(request('bad')))
          seen.push(event);
      })(),
      errorCode(index === 1 ? 'provider_error' : 'invalid_response'),
    );
    assert.equal(
      seen.some((value) => value.type === 'message_end'),
      false,
    );
  }
});

test('非流式及流式 Provider 错误公开消息不会泄露密钥、响应正文和取消原因', async () => {
  const secret = 'test-super-secret-key';
  for (const status of [401, 403, 429, 400, 500]) {
    const client = new OpenAICompatibleModelClient({
      baseURL: 'https://provider.invalid/v1',
      apiKey: secret,
      fetch: async () =>
        Response.json(
          { error: { message: `Authorization: Bearer ${secret}` } },
          { status },
        ),
    });
    for (const action of [
      () => client.generate(request('bad')),
      () => collect(client.stream(request('bad'))),
    ]) {
      await assert.rejects(action(), (error: unknown) => {
        assert.ok(error instanceof ModelError);
        assert.equal(error.status, status);
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.stack?.includes(secret), false);
        return true;
      });
    }
  }
});

test('收到 message_end 时资源已释放，调用方不继续迭代也不保留连接', async () => {
  const stream = feed();
  const controller = new AbortController();
  let signal: AbortSignal | null | undefined;
  const client = new OpenAICompatibleModelClient({
    baseURL: 'https://provider.invalid/v1',
    fetch: async (_input, init) => {
      signal = init?.signal;
      return stream.response;
    },
  });
  stream.write(
    frame(chunk('end', { content: 'done' }, 'stop')) + 'data: [DONE]\n\n',
  );
  const events = client.stream(request('end'), {
    signal: controller.signal,
    timeoutMs: 1000,
  });
  const iterator = events[Symbol.asyncIterator]();
  while (true) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    if (next.value.type === 'message_end') break;
  }
  assert.equal(stream.cancellations, 1);
  assert.equal(signal?.aborted, true);
  controller.abort();
  assert.equal((await iterator.next()).done, true);
});

test(
  '忽略 signal 的 transport 在超时后迟到，响应体仍会被释放',
  { timeout: 3000 },
  async () => {
    const transport = deferred<Response>();
    const cancelled = deferred<void>();
    const client = new OpenAICompatibleModelClient({
      baseURL: 'https://provider.invalid/v1',
      fetch: () => transport.promise,
    });
    await assert.rejects(
      client.generate(request('late'), { timeoutMs: 20 }),
      errorCode('timeout'),
    );
    transport.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled.resolve();
          },
        }),
      ),
    );
    await cancelled.promise;
  },
);

test('transport 同步触发取消并拒绝时保持 aborted，接管底层 Promise 拒绝', async () => {
  const controller = new AbortController();
  const client = new OpenAICompatibleModelClient({
    baseURL: 'https://provider.invalid/v1',
    fetch: () => {
      controller.abort();
      return Promise.reject(new Error('private transport failure'));
    },
  });
  await assert.rejects(
    client.generate(request('race'), { signal: controller.signal }),
    errorCode('aborted'),
  );
  await new Promise((resolve) => setImmediate(resolve));
});
