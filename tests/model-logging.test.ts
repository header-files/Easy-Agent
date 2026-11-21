import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  ModelError,
  OpenAICompatibleModelClient,
  type Logger,
  type LogFields,
  type LogLevel,
  type ModelRequest,
  type ModelStreamEvent,
} from '../src/index.ts';

const execFileAsync = promisify(execFile);
interface Entry {
  level: LogLevel;
  module: string;
  message: string;
  fields: LogFields;
}

function capture() {
  const entries: Entry[] = [];
  function logger(module = 'test', bindings: LogFields = {}): Logger {
    const write = (level: LogLevel, message: string, fields?: LogFields) => {
      entries.push({
        level,
        module,
        message,
        fields: { ...bindings, ...fields },
      });
    };
    return {
      debug: (message, fields) => write('debug', message, fields),
      info: (message, fields) => write('info', message, fields),
      warn: (message, fields) => write('warn', message, fields),
      error: (message, fields) => write('error', message, fields),
      child: (name, fields) => logger(name, { ...bindings, ...fields }),
    };
  }
  return { logger: logger(), entries };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function request(model = 'test-model'): ModelRequest {
  return {
    model,
    messages: [{ role: 'user', content: 'PRIVATE_PROMPT_CONTENT' }],
    parameters: { vendor: 'PRIVATE_PARAMETER_VALUE' },
  };
}

function response(): Response {
  return Response.json({
    id: 'PRIVATE_PROVIDER_ID',
    model: 'PRIVATE_PROVIDER_MODEL',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'PRIVATE_RESPONSE_CONTENT' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  });
}

function frame(delta: unknown, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'PRIVATE_PROVIDER_ID',
    model: 'PRIVATE_PROVIDER_MODEL',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function streamBody(): Response {
  return new Response(
    frame({ content: 'PRIVATE_RESPONSE_CONTENT' }) +
      frame({}, 'stop') +
      'data: [DONE]\n\n',
  );
}

function feed() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel() {
      cancelled++;
    },
  });
  return {
    response: new Response(body),
    write(text: string) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    get cancelled() {
      return cancelled;
    },
  };
}

async function collect(events: AsyncIterable<ModelStreamEvent>) {
  const result: ModelStreamEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function lifecycle(entries: Entry[], operation: string, terminal: string) {
  assert.equal(entries.length, 2);
  const [start, finish] = entries;
  assert.equal(start?.fields.event, 'model.request.started');
  assert.equal(start?.level, 'debug');
  assert.equal(finish?.fields.event, `model.request.${terminal}`);
  assert.equal(start?.fields.operation, operation);
  assert.equal(finish?.fields.operation, operation);
  assert.equal(start?.module, 'runtime.model.openai-compatible');
  assert.equal(finish?.module, 'runtime.model.openai-compatible');
  assert.equal(typeof start?.fields.requestId, 'string');
  assert.ok(String(start?.fields.requestId).length > 0);
  assert.equal(finish?.fields.requestId, start?.fields.requestId);
  assert.equal(typeof finish?.fields.durationMs, 'number');
  assert.ok(Number(finish?.fields.durationMs) >= 0);
  return finish!;
}

test('generate 生命周期使用 Logger 契约，成功记录耗时、结束原因和真实 Usage', async () => {
  const { logger, entries } = capture();
  const client = new OpenAICompatibleModelClient({
    logger,
    fetch: async () => response(),
  });
  const result = await client.generate(request());
  const done = lifecycle(entries, 'generate', 'completed');
  assert.equal(done.level, 'info');
  assert.equal(done.fields.finishReason, result.finishReason);
  assert.deepEqual(done.fields.usage, result.usage);
});

test('stream 保持惰性，终态日志在交付 message_end 前完成且仅一次', async () => {
  const { logger, entries } = capture();
  const client = new OpenAICompatibleModelClient({
    logger,
    fetch: async () => streamBody(),
  });
  const iterable = client.stream(request());
  assert.equal(entries.length, 0);
  const iterator = iterable[Symbol.asyncIterator]();
  while (true) {
    const next = await iterator.next();
    assert.equal(next.done, false);
    if (next.value.type === 'message_end') break;
  }
  const done = lifecycle(entries, 'stream', 'completed');
  assert.equal(done.level, 'info');
  assert.equal(done.fields.usage, undefined);
  assert.equal((await iterator.next()).done, true);
  assert.equal(entries.length, 2);
});

test('参数校验失败记录统一 invalid_request，仍不访问传输层', async () => {
  const { logger, entries } = capture();
  let calls = 0;
  const client = new OpenAICompatibleModelClient({
    logger,
    fetch: async () => {
      calls++;
      return response();
    },
  });
  await assert.rejects(client.generate({ ...request(), model: '' }), {
    code: 'invalid_request',
  });
  const failed = lifecycle(entries, 'generate', 'failed');
  assert.equal(failed.level, 'error');
  assert.equal(failed.fields.code, 'invalid_request');
  assert.equal(calls, 0);
});

test('网络失败、HTTP失败和协议失败均记录 ERROR 与安全统一错误', async () => {
  for (const [fetch, code] of [
    [
      async () => {
        throw new TypeError('PRIVATE_NETWORK_EXCEPTION');
      },
      'network',
    ],
    [
      async () => new Response('PRIVATE_PROVIDER_BODY', { status: 401 }),
      'authentication',
    ],
    [async () => Response.json({ choices: [] }), 'invalid_response'],
  ] as const) {
    const { logger, entries } = capture();
    const client = new OpenAICompatibleModelClient({ logger, fetch });
    await assert.rejects(client.generate(request()), { code });
    const failed = lifecycle(entries, 'generate', 'failed');
    assert.equal(failed.level, 'error');
    assert.equal(failed.fields.code, code);
    assert.equal(typeof failed.fields.retryable, 'boolean');
    const error = failed.fields.err as Record<string, unknown>;
    assert.equal(error.code, code);
    assert.equal(error.name, 'ModelError');
    if (code === 'authentication') {
      assert.equal(failed.fields.status, 401);
      assert.equal(error.status, 401);
    } else {
      assert.equal(Object.hasOwn(failed.fields, 'status'), false);
      assert.equal(Object.hasOwn(error, 'status'), false);
    }
    assert.equal(JSON.stringify(entries).includes('PRIVATE_'), false);
  }
});

test('无脱敏功能的注入 Logger 也收不到请求/响应载荷、配置或原始异常', async () => {
  const { logger, entries } = capture();
  const apiKey = 'PRIVATE_CREDENTIAL_VALUE';
  let fail = false;
  const originalError = new ModelError(
    {
      code: 'provider_error',
      message: 'PRIVATE_MODEL_ERROR_MESSAGE',
      retryable: true,
    },
    { cause: new Error('PRIVATE_MODEL_ERROR_CAUSE') },
  );
  const client = new OpenAICompatibleModelClient({
    logger,
    apiKey,
    baseURL: 'https://provider.invalid/PRIVATE_BASE_PATH',
    fetch: async () => {
      if (fail) throw originalError;
      return response();
    },
  });
  await client.generate(request(`requested-${apiKey}`));
  fail = true;
  await assert.rejects(
    client.generate(request()),
    (error) => error === originalError,
  );
  const encoded = JSON.stringify(entries);
  assert.equal(encoded.includes('PRIVATE_'), false);
  assert.equal(encoded.includes('[REDACTED]'), true);
  for (const entry of entries) {
    for (const key of Object.keys(entry.fields)) {
      assert.ok(
        [
          'event',
          'requestId',
          'operation',
          'model',
          'durationMs',
          'finishReason',
          'usage',
          'code',
          'retryable',
          'status',
          'err',
        ].includes(key),
        `Unexpected field ${key}`,
      );
    }
  }
});

test('流式工具调用只记录元数据，不输出文本或工具参数增量', async () => {
  const { logger, entries } = capture();
  const client = new OpenAICompatibleModelClient({
    logger,
    fetch: async () =>
      new Response(
        frame({
          tool_calls: [
            {
              index: 0,
              id: 'PRIVATE_TOOL_ID',
              type: 'function',
              function: {
                name: 'tool',
                arguments: '{"secret":"PRIVATE_TOOL_ARGUMENTS"}',
              },
            },
          ],
        }) +
          frame({}, 'tool_calls') +
          'data: [DONE]\n\n',
      ),
  });
  const events = await collect(client.stream(request()));
  const last = events.at(-1);
  assert.equal(last?.type, 'message_end');
  const done = lifecycle(entries, 'stream', 'completed');
  assert.equal(done.fields.finishReason, 'tool_calls');
  assert.equal(JSON.stringify(entries).includes('PRIVATE_'), false);
});

test(
  '并发 generate/stream 的关联 ID 和终态相互隔离',
  { timeout: 3000 },
  async () => {
    const { logger, entries } = capture();
    const arrived = deferred<void>();
    const gates = new Map<string, ReturnType<typeof deferred<Response>>>();
    const client = new OpenAICompatibleModelClient({
      logger,
      fetch: async (_input, init) => {
        const { model } = JSON.parse(String(init?.body)) as { model: string };
        const gate = deferred<Response>();
        gates.set(model, gate);
        if (gates.size === 3) arrived.resolve();
        return gate.promise;
      },
    });
    const tasks = [
      client.generate(request('alpha')),
      collect(client.stream(request('beta'))),
      client.generate(request('gamma')),
    ];
    await arrived.promise;
    assert.equal(
      new Set(entries.map((entry) => entry.fields.requestId)).size,
      3,
    );
    gates.get('gamma')!.resolve(response());
    gates.get('beta')!.resolve(streamBody());
    gates.get('alpha')!.resolve(response());
    await Promise.all(tasks);
    for (const model of ['alpha', 'beta', 'gamma']) {
      const ownEntries = entries.filter(
        (entry) => entry.fields.model === model,
      );
      lifecycle(
        ownEntries,
        model === 'beta' ? 'stream' : 'generate',
        'completed',
      );
    }
  },
);

test(
  '主动取消与超时记录 WARN，保留原始错误码且不产生成功日志',
  { timeout: 3000 },
  async () => {
    for (const mode of ['aborted', 'timeout'] as const) {
      const { logger, entries } = capture();
      const started = deferred<void>();
      const controller = new AbortController();
      const client = new OpenAICompatibleModelClient({
        logger,
        fetch: async () => {
          started.resolve();
          return new Promise<Response>(() => {});
        },
      });
      const rejected = assert.rejects(
        client.generate(request(), {
          signal: controller.signal,
          timeoutMs: mode === 'timeout' ? 20 : 1000,
        }),
        { code: mode },
      );
      await started.promise;
      if (mode === 'aborted')
        controller.abort(new Error('PRIVATE_ABORT_REASON'));
      await rejected;
      const cancelled = lifecycle(entries, 'generate', 'cancelled');
      assert.equal(cancelled.level, 'warn');
      assert.equal(cancelled.fields.code, mode);
      assert.equal(JSON.stringify(entries).includes('PRIVATE_'), false);
    }
  },
);

test('流式提前退出记录 consumer_return 并释放连接，没有成功终态', async () => {
  const { logger, entries } = capture();
  const stream = feed();
  stream.write(frame({ content: 'PRIVATE_PARTIAL_TEXT' }));
  const client = new OpenAICompatibleModelClient({
    logger,
    fetch: async () => stream.response,
  });
  for await (const event of client.stream(request())) {
    if (event.type === 'text_delta') break;
  }
  const cancelled = lifecycle(entries, 'stream', 'cancelled');
  assert.equal(cancelled.level, 'warn');
  assert.equal(cancelled.fields.code, 'consumer_return');
  assert.equal(stream.cancelled, 1);
  assert.equal(JSON.stringify(entries).includes('PRIVATE_'), false);
});

test(
  '消费者暂停期间已取消或超时，直接 return 仍保留实际取消原因',
  { timeout: 3000 },
  async () => {
    for (const code of ['aborted', 'timeout'] as const) {
      const { logger, entries } = capture();
      const stream = feed();
      stream.write(frame({ content: 'PRIVATE_PARTIAL_TEXT' }));
      const controller = new AbortController();
      const client = new OpenAICompatibleModelClient({
        logger,
        fetch: async () => stream.response,
      });
      const events = client.stream(request(), {
        signal: controller.signal,
        timeoutMs: code === 'timeout' ? 20 : 1000,
      });
      const iterator = events[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).value.type, 'message_start');
      if (code === 'aborted') controller.abort();
      else await new Promise((resolve) => setTimeout(resolve, 30));
      await iterator.return?.();
      const cancelled = lifecycle(entries, 'stream', 'cancelled');
      assert.equal(cancelled.level, 'warn');
      assert.equal(cancelled.fields.code, code);
      assert.equal(stream.cancelled, 1);
    }
  },
);

test(
  '流式读取取消/超时和协议失败各自只有一个正确终态',
  { timeout: 3000 },
  async () => {
    for (const mode of ['aborted', 'timeout', 'invalid_response'] as const) {
      const { logger, entries } = capture();
      const stream = feed();
      stream.write(frame({ content: 'PRIVATE_PARTIAL_TEXT' }));
      const controller = new AbortController();
      const client = new OpenAICompatibleModelClient({
        logger,
        fetch: async () =>
          mode === 'invalid_response'
            ? new Response('data: not-json\n\n')
            : stream.response,
      });
      await assert.rejects(
        (async () => {
          for await (const event of client.stream(request(), {
            signal: controller.signal,
            timeoutMs: 20,
          })) {
            if (mode === 'aborted' && event.type === 'text_delta')
              controller.abort();
          }
        })(),
        { code: mode },
      );
      const terminal = lifecycle(
        entries,
        'stream',
        mode === 'invalid_response' ? 'failed' : 'cancelled',
      );
      assert.equal(
        terminal.level,
        mode === 'invalid_response' ? 'error' : 'warn',
      );
      assert.equal(terminal.fields.code, mode);
    }
  },
);

test('日志方法和 child 初始化失败不会改变模型响应、异常或流资源释放', async () => {
  function throwingLogger(childThrows = false): Logger {
    const fail = () => {
      throw new Error('PRIVATE_LOGGING_FAILURE');
    };
    return {
      debug: fail,
      info: fail,
      warn: fail,
      error: fail,
      child: () => (childThrows ? fail() : throwingLogger()),
    };
  }
  for (const logger of [throwingLogger(), throwingLogger(true)]) {
    const client = new OpenAICompatibleModelClient({
      logger,
      fetch: async () => response(),
    });
    assert.equal((await client.generate(request())).finishReason, 'stop');
    const bad = new OpenAICompatibleModelClient({
      logger,
      fetch: async () => {
        throw new TypeError('transport error');
      },
    });
    await assert.rejects(bad.generate(request()), { code: 'network' });
    const stream = feed();
    stream.write(frame({ content: 'PRIVATE_PARTIAL_TEXT' }));
    const streaming = new OpenAICompatibleModelClient({
      logger,
      fetch: async () => stream.response,
    });
    for await (const event of streaming.stream(request())) {
      if (event.type === 'text_delta') break;
    }
    assert.equal(stream.cancelled, 1);
  }
});

test('未注入 Logger 时使用 stderr 和 LOG_LEVEL，日志不包含模型载荷', async () => {
  const moduleUrl = new URL('../src/index.ts', import.meta.url).href;
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const {OpenAICompatibleModelClient} = await import(${JSON.stringify(moduleUrl)});
     const client = new OpenAICompatibleModelClient({
       apiKey:'PRIVATE_DEFAULT_KEY',
       fetch:async()=>Response.json({choices:[{message:{role:'assistant',content:'PRIVATE_OUTPUT'},finish_reason:'stop'}]})
     });
     await client.generate({model:'test-model',messages:[{role:'user',content:'PRIVATE_INPUT'}]});`,
    ],
    { env: { ...process.env, LOG_LEVEL: 'DEBUG' } },
  );
  assert.equal(stdout, '');
  assert.equal(stderr.includes('PRIVATE_'), false);
  const records = stderr
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.deepEqual(
    records.map((record) => record.level),
    ['DEBUG', 'INFO'],
  );
  assert.deepEqual(
    records.map((record) => record.event),
    ['model.request.started', 'model.request.completed'],
  );
  assert.ok(
    records.every(
      (record) => record.module === 'runtime.model.openai-compatible',
    ),
  );
});

test('默认日志初始化失败也不阻断模型请求', async () => {
  const moduleUrl = new URL('../src/index.ts', import.meta.url).href;
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const {OpenAICompatibleModelClient} = await import(${JSON.stringify(moduleUrl)});
     const client = new OpenAICompatibleModelClient({fetch:async()=>Response.json({choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}]})});
     const result=await client.generate({model:'test-model',messages:[{role:'user',content:'hi'}]});
     process.stdout.write(result.message.content);`,
    ],
    { env: { ...process.env, LOG_LEVEL: 'invalid-level' } },
  );
  assert.equal(stdout, 'ok');
  assert.equal(stderr, '');
});

test('满足 void 契约的异步 Logger 拒绝也被接管，不影响模型结果', async () => {
  const fail = async () => {
    throw new Error('PRIVATE_ASYNC_LOGGER_FAILURE');
  };
  const logger: Logger = {
    debug: fail,
    info: fail,
    warn: fail,
    error: fail,
    child: () => logger,
  };
  const client = new OpenAICompatibleModelClient({
    logger,
    fetch: async () => response(),
  });
  assert.equal((await client.generate(request())).finishReason, 'stop');
  const bad = new OpenAICompatibleModelClient({
    logger,
    fetch: async () => new Response('private', { status: 503 }),
  });
  await assert.rejects(bad.generate(request()), { code: 'provider_error' });
  const stream = feed();
  stream.write(frame({ content: 'PRIVATE_PARTIAL_TEXT' }));
  const streaming = new OpenAICompatibleModelClient({
    logger,
    fetch: async () => stream.response,
  });
  for await (const event of streaming.stream(request())) {
    if (event.type === 'text_delta') break;
  }
  assert.equal(stream.cancelled, 1);
  await new Promise((resolve) => setImmediate(resolve));
});

test('注入 Logger 修改收到的 Usage 不会改写调用方的模型响应', async () => {
  const logger: Logger = {
    debug() {},
    info(_message, fields) {
      if (fields?.usage && typeof fields.usage === 'object') {
        Object.assign(fields.usage, { totalTokens: -999 });
      }
    },
    warn() {},
    error() {},
    child: () => logger,
  };
  const client = new OpenAICompatibleModelClient({
    logger,
    fetch: async () => response(),
  });
  const result = await client.generate(request());
  assert.deepEqual(result.usage, {
    inputTokens: 2,
    outputTokens: 3,
    totalTokens: 5,
  });
});
