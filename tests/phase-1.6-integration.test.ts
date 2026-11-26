import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { runCli } from '../src/application/cli/index.ts';
import { AgentApplicationError } from '../src/application/index.ts';
import {
  bootstrap,
  resolveConfig,
  type EasyAgentApplication,
  type EasyAgentConfig,
} from '../src/composition/index.ts';
import { SessionEventBufferOverflowError } from '../src/agent/index.ts';
import type { SessionExecution } from '../src/harness/contracts/agent/index.ts';
import type { ExecutionEvent } from '../src/harness/contracts/execution/index.ts';
import {
  ModelError,
  type ModelCallOptions,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
  type ModelToolCall,
} from '../src/harness/contracts/model/index.ts';
import type { Logger } from '../src/runtime/logging/index.ts';

const quiet: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return quiet;
  },
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function model(
  stream: (
    request: ModelRequest,
    options?: ModelCallOptions,
  ) => AsyncIterable<ModelStreamEvent>,
): ModelClient {
  return {
    async generate() {
      assert.fail('DefaultAgentLoop must use the streaming contract.');
    },
    stream,
  };
}

async function* response(
  request: ModelRequest,
  output: string,
  calls: ModelToolCall[] = [],
): AsyncGenerator<ModelStreamEvent> {
  yield { type: 'message_start', model: request.model };
  if (output) yield { type: 'text_delta', text: output };
  for (const [index, call] of calls.entries())
    yield {
      type: 'tool_call_delta',
      index,
      id: call.id,
      name: call.name,
      argumentsDelta: call.argumentsJson,
    };
  yield {
    type: 'message_end',
    response: {
      model: request.model,
      message: {
        role: 'assistant',
        content: output || null,
        ...(calls.length ? { toolCalls: calls } : {}),
      },
      finishReason: calls.length ? 'tool_calls' : 'stop',
    },
  };
}

function lastInput(request: ModelRequest): string {
  return request.messages.findLast((item) => item.role === 'user')!.content;
}

function config() {
  return resolveConfig({
    fileConfig: {
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: 'https://provider.invalid/v1',
        },
      },
      models: ['fixture/offline-model'],
      defaultModel: 'fixture/offline-model',
      agent: { maxModelRetries: 0 },
    },
  });
}

function provider(client: ModelClient) {
  return {
    providerFactories: {
      'openai-compatible': () => ({ client }),
    },
  } as const;
}

function cliOptions(client: ModelClient) {
  return {
    env: {},
    async loadConfig() {
      return config();
    },
    bootstrap: (effective: EasyAgentConfig) =>
      bootstrap(effective, { ...provider(client), logger: quiet }),
  };
}

function capture(onWrite?: (text: string) => void) {
  let text = '';
  const stream = new Writable({
    write(chunk: Buffer, _encoding, next) {
      const part = chunk.toString();
      text += part;
      onWrite?.(part);
      next();
    },
  });
  return { stream, text: () => text };
}

async function collect(events: AsyncIterable<ExecutionEvent>) {
  const items: ExecutionEvent[] = [];
  for await (const item of events) items.push(item);
  return items;
}

test('CLI通过真实装配实时展示output_delta，model_event不重复正文且最终结果不重复追加', async () => {
  const visible = deferred();
  const finish = deferred();
  const input = new PassThrough();
  const output = capture((text) => {
    if (text === '实时回答') visible.resolve();
  });
  const errors = capture();
  let completed = false;
  const client = model(async function* (request) {
    yield { type: 'message_start', model: request.model };
    yield { type: 'text_delta', text: '实时回答' };
    await finish.promise;
    const final: ModelResponse = {
      model: request.model,
      message: { role: 'assistant', content: '实时回答' },
      finishReason: 'stop',
    };
    yield { type: 'message_end', response: final };
  });
  const running = runCli(['chat'], {
    input,
    output: output.stream,
    error: errors.stream,
    ...cliOptions(client),
  }).then((code) => {
    completed = true;
    return code;
  });
  input.write('hello\n');
  try {
    await visible.promise;
    assert.equal(completed, false);
    assert.equal(output.text().split('实时回答').length - 1, 1);
  } finally {
    finish.resolve();
    input.end('/exit\n');
  }
  assert.equal(await running, 0);
  assert.equal(output.text().split('实时回答').length - 1, 1);
  assert.equal(output.text().split('[COMPLETED]').length - 1, 1);
  assert.equal(errors.text(), '');
});

test('CLI多轮继承上下文且/new创建空历史，不删除旧Session或把历史带入新Session', async () => {
  const requests: ModelRequest[] = [];
  const output = capture();
  const errors = capture();
  let sessionsBeforeExit = 0;
  const client = model((request) => {
    requests.push(structuredClone(request));
    return response(request, `answer-${lastInput(request)}`);
  });
  const exitCode = await runCli(['chat'], {
    input: Readable.from(['first\nsecond\n/new\nthird\n/exit\n']),
    output: output.stream,
    error: errors.stream,
    env: {},
    async loadConfig() {
      return config();
    },
    bootstrap: async (effective) => {
      const app = await bootstrap(effective, {
        ...provider(client),
        logger: quiet,
      });
      return {
        service: app.service,
        async dispose() {
          sessionsBeforeExit = app.service.listSessions().length;
          await app.dispose();
        },
      };
    },
  });
  assert.equal(exitCode, 0);
  assert.deepEqual(
    requests.map((request) => request.messages),
    [
      [{ role: 'user', content: 'first' }],
      [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer-first' },
        { role: 'user', content: 'second' },
      ],
      [{ role: 'user', content: 'third' }],
    ],
  );
  assert.equal(sessionsBeforeExit, 2);
  assert.match(output.text(), /已切换至新 Session/);
  assert.equal(errors.text(), '');
});

test('真实bootstrap贯通模型→注入工具→模型，结果与提交上下文保持调用ID配对', async () => {
  const requests: ModelRequest[] = [];
  const output = capture();
  const errors = capture();
  let submitted: SessionExecution | undefined;
  const client = model((request) => {
    requests.push(structuredClone(request));
    if (requests.length === 1) {
      assert.ok(request.tools?.some((tool) => tool.name === 'add'));
      return response(request, 'Calculating the sum.\n', [
        { id: 'addition-1', name: 'add', argumentsJson: '{"a":2,"b":3}' },
      ]);
    }
    assert.deepEqual(request.messages.at(-1), {
      role: 'tool',
      toolCallId: 'addition-1',
      content: '5',
      isError: false,
    });
    return response(request, '2 + 3 = 5');
  });
  const exitCode = await runCli(['chat'], {
    input: Readable.from(['add two and three\n/exit\n']),
    output: output.stream,
    error: errors.stream,
    env: {},
    async loadConfig() {
      return config();
    },
    bootstrap: async (effective) => {
      const app = await bootstrap(effective, {
        ...provider(client),
        logger: quiet,
        tools: [
          {
            spec: {
              name: 'add',
              description: 'Add two finite numbers and return their sum.',
              parameters: {
                type: 'object',
                properties: { a: { type: 'number' }, b: { type: 'number' } },
                required: ['a', 'b'],
                additionalProperties: false,
              },
            },
            handler(args) {
              return {
                content: String((args.a as number) + (args.b as number)),
              };
            },
          },
        ],
      });
      const delegate = app.service;
      return {
        service: {
          ...delegate,
          submit(sessionId, input, options) {
            submitted = delegate.submit(sessionId, input, options);
            return submitted;
          },
        },
        dispose: () => app.dispose(),
      };
    },
  });
  assert.equal(exitCode, 0);
  assert.ok(submitted);
  const result = await submitted.result;
  assert.equal(result.status, 'COMPLETED');
  assert.equal(requests.length, 2);
  assert.equal(output.text().split('Calculating the sum.').length - 1, 1);
  assert.equal(output.text().split('2 + 3 = 5').length - 1, 1);
  assert.doesNotMatch(output.text(), /替换此前预览/);
  assert.equal(errors.text(), '');
  if (result.status === 'COMPLETED') {
    assert.equal(result.loopResult.output, '2 + 3 = 5');
    assert.deepEqual(result.loopResult.updatedContext?.messages.at(-2), {
      role: 'tool',
      toolCallId: 'addition-1',
      content: '5',
      isError: false,
    });
  }
});

test('同一模型响应的多个ToolCall经真实ToolExecutor严格串行并按ID顺序回填', async () => {
  const firstEntered = deferred();
  const release = deferred();
  const calls: string[] = [];
  let active = 0;
  let maxActive = 0;
  let rounds = 0;
  const client = model((request) => {
    if (++rounds === 1)
      return response(request, '', [
        { id: 'probe-1', name: 'probe', argumentsJson: '{"value":1}' },
        { id: 'probe-2', name: 'probe', argumentsJson: '{"value":2}' },
      ]);
    assert.deepEqual(
      request.messages.filter((item) => item.role === 'tool'),
      [
        {
          role: 'tool',
          toolCallId: 'probe-1',
          content: 'value-1',
          isError: false,
        },
        {
          role: 'tool',
          toolCallId: 'probe-2',
          content: 'value-2',
          isError: false,
        },
      ],
    );
    return response(request, 'serial result');
  });
  const app = await bootstrap(config(), {
    ...provider(client),
    logger: quiet,
    tools: [
      {
        spec: {
          name: 'probe',
          description: 'Offline serialization probe.',
          parameters: {
            type: 'object',
            properties: { value: { type: 'integer' } },
            required: ['value'],
            additionalProperties: false,
          },
        },
        async handler(args, context) {
          calls.push(context.toolCallId);
          maxActive = Math.max(maxActive, ++active);
          try {
            if (args.value === 1) {
              firstEntered.resolve();
              await release.promise;
            }
            return { content: `value-${String(args.value)}` };
          } finally {
            active--;
          }
        },
      },
    ],
  });
  try {
    const execution = app.service.submit(
      (await app.service.createSession()).sessionId,
      'two probes',
    );
    await firstEntered.promise;
    assert.deepEqual(calls, ['probe-1']);
    assert.equal(rounds, 1);
    release.resolve();
    assert.equal((await execution.result).status, 'COMPLETED');
    assert.deepEqual(calls, ['probe-1', 'probe-2']);
    assert.equal(maxActive, 1);
    assert.equal(rounds, 2);
  } finally {
    release.resolve();
    await app.dispose();
  }
});

test('真实ToolRuntime将工具业务失败安全回填，模型可继续完成而非把工具错误伪装成功', async () => {
  const secret = 'private-handler-detail';
  let rounds = 0;
  const client = model((request) => {
    if (++rounds === 1)
      return response(request, '', [
        { id: 'failure-1', name: 'failing', argumentsJson: '{}' },
      ]);
    const tool = request.messages.at(-1);
    assert.equal(tool?.role, 'tool');
    assert.ok(tool?.role === 'tool' && tool.isError);
    assert.equal(tool.toolCallId, 'failure-1');
    assert.equal(tool.content, 'Tool execution failed.');
    assert.ok(!JSON.stringify(request).includes(secret));
    return response(request, 'The tool failed; no result was produced.');
  });
  const app = await bootstrap(config(), {
    ...provider(client),
    logger: quiet,
    tools: [
      {
        spec: {
          name: 'failing',
          description: 'Offline error probe.',
          parameters: { type: 'object' },
        },
        handler() {
          throw new Error(secret);
        },
      },
    ],
  });
  try {
    const execution = app.service.submit(
      (await app.service.createSession()).sessionId,
      'call failing tool',
    );
    const events = await collect(execution.events);
    const toolEvent = events.find(
      (item) => item.type === 'loop_event' && item.event.type === 'tool_result',
    );
    assert.ok(
      toolEvent?.type === 'loop_event' &&
        toolEvent.event.type === 'tool_result',
    );
    assert.equal(toolEvent.event.result.status, 'error');
    assert.equal(toolEvent.event.result.error?.code, 'execution_failed');
    assert.equal((await execution.result).status, 'COMPLETED');
    assert.equal(rounds, 2);
    assert.ok(!JSON.stringify(events).includes(secret));
  } finally {
    await app.dispose();
  }
});

test('CLI Ctrl+C显式调用Service取消并等待真实模型流清理后显示CANCELLED', async () => {
  const entered = deferred();
  const input = new PassThrough();
  const output = capture();
  const errors = capture();
  const signals = new EventEmitter();
  let closed = false;
  let abortObserved = false;
  let cancelCalls = 0;
  let application: EasyAgentApplication | undefined;
  const client = model(async function* (request, options) {
    try {
      yield { type: 'message_start', model: request.model };
      entered.resolve();
      await new Promise<never>((_resolve, reject) => {
        const abort = () => {
          abortObserved = true;
          reject(
            new ModelError({
              code: 'aborted',
              message: 'Cancelled.',
              retryable: false,
            }),
          );
        };
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener('abort', abort, { once: true });
      });
    } finally {
      closed = true;
    }
  });
  const running = runCli(['chat'], {
    input,
    output: output.stream,
    error: errors.stream,
    env: {},
    signals,
    async loadConfig() {
      return config();
    },
    bootstrap: async (effective) => {
      application = await bootstrap(effective, {
        ...provider(client),
        logger: quiet,
      });
      const delegate = application.service;
      return {
        service: {
          ...delegate,
          cancel(sessionId, executionId) {
            cancelCalls++;
            return delegate.cancel(sessionId, executionId);
          },
        },
        dispose: () => application!.dispose(),
      };
    },
  });
  input.write('cancel this\n');
  await entered.promise;
  signals.emit('SIGINT');
  signals.emit('SIGINT');
  input.end('/exit\n');
  assert.equal(await running, 0);
  assert.equal(cancelCalls, 1);
  assert.equal(abortObserved, true);
  assert.equal(closed, true);
  assert.match(output.text(), /\[CANCELLED\]/);
  assert.doesNotMatch(output.text(), /\[COMPLETED\]/);
  assert.match(errors.text(), /取消请求已发送/);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.throws(
    () => application!.service.listSessions(),
    (error: unknown) =>
      error instanceof AgentApplicationError &&
      error.code === 'application_disposed',
  );
});

test('模型失败经真实链路呈现FAILED，未提交部分上下文且下一轮仍能继续', async () => {
  const secret = 'private-provider-detail';
  const requests: ModelRequest[] = [];
  const output = capture();
  const errors = capture();
  const client = model(async function* (request) {
    requests.push(structuredClone(request));
    if (lastInput(request) === 'fail') {
      yield { type: 'message_start', model: request.model };
      yield { type: 'text_delta', text: 'partial' };
      throw new ModelError({
        code: 'network',
        message: secret,
        retryable: false,
      });
    }
    yield* response(request, 'recovered-answer');
  });
  const exitCode = await runCli(['chat'], {
    input: Readable.from(['fail\nrecover\n/exit\n']),
    output: output.stream,
    error: errors.stream,
    ...cliOptions(client),
  });
  assert.equal(exitCode, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]?.messages, [
    { role: 'user', content: 'recover' },
  ]);
  assert.match(errors.text(), /\[FAILED: loop_error\]/);
  assert.equal(output.text().split('recovered-answer').length - 1, 1);
  assert.equal(output.text().split('[COMPLETED]').length - 1, 1);
  assert.ok(!output.text().includes(secret));
  assert.ok(!errors.text().includes(secret));
});

test('Service观察提前退出或默认缓冲溢出均不取消执行，成功上下文与独立result继续生效', async () => {
  const requests: ModelRequest[] = [];
  const client = model(async function* (request) {
    requests.push(structuredClone(request));
    const output =
      lastInput(request) === 'overflow' ? 'x'.repeat(300) : 'answer';
    yield { type: 'message_start', model: request.model };
    if (lastInput(request) === 'overflow') {
      for (const text of output) yield { type: 'text_delta', text };
    } else yield { type: 'text_delta', text: output };
    yield {
      type: 'message_end',
      response: {
        model: request.model,
        message: { role: 'assistant', content: output },
        finishReason: 'stop',
      },
    };
  });
  const app = await bootstrap(config(), { ...provider(client), logger: quiet });
  try {
    const session = await app.service.createSession();
    const detached = app.service.submit(session.sessionId, 'detach');
    const observer = detached.events[Symbol.asyncIterator]();
    assert.equal((await observer.next()).value.type, 'execution_start');
    await observer.return?.();
    assert.equal((await detached.result).status, 'COMPLETED');

    const overflow = app.service.submit(session.sessionId, 'overflow');
    const result = await overflow.result;
    assert.equal(result.status, 'COMPLETED');
    await assert.rejects(
      collect(overflow.events),
      SessionEventBufferOverflowError,
    );
    const next = app.service.submit(session.sessionId, 'next');
    assert.equal((await next.result).status, 'COMPLETED');
    assert.deepEqual(requests[2]?.messages, [
      { role: 'user', content: 'detach' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'overflow' },
      { role: 'assistant', content: 'x'.repeat(300) },
      { role: 'user', content: 'next' },
    ]);
  } finally {
    await app.dispose();
  }
});

test('共享装配组件下跨Session真实模型调用并发，同Session仍FIFO且历史不串扰', async () => {
  const entered = deferred();
  const release = deferred();
  const requests: ModelRequest[] = [];
  const client = model(async function* (request) {
    requests.push(structuredClone(request));
    if (lastInput(request) === 'A1') {
      entered.resolve();
      await release.promise;
    }
    yield* response(request, `answer-${lastInput(request)}`);
  });
  const app = await bootstrap(config(), { ...provider(client), logger: quiet });
  try {
    const first = await app.service.createSession();
    const second = await app.service.createSession();
    const a1 = app.service.submit(first.sessionId, 'A1');
    const a2 = app.service.submit(first.sessionId, 'A2');
    await entered.promise;
    const b1 = app.service.submit(second.sessionId, 'B1');
    assert.equal((await b1.result).status, 'COMPLETED');
    assert.equal(app.service.cancel(second.sessionId, a1.executionId), false);
    assert.deepEqual(requests.map(lastInput), ['A1', 'B1']);
    assert.equal(
      app.service.listSessions()[0]?.runningExecutionId,
      a1.executionId,
    );
    release.resolve();
    assert.equal((await a1.result).status, 'COMPLETED');
    assert.equal((await a2.result).status, 'COMPLETED');
    assert.deepEqual(requests[2]?.messages, [
      { role: 'user', content: 'A1' },
      { role: 'assistant', content: 'answer-A1' },
      { role: 'user', content: 'A2' },
    ]);
    assert.deepEqual(requests[1]?.messages, [{ role: 'user', content: 'B1' }]);
  } finally {
    release.resolve();
    await app.dispose();
  }
});
