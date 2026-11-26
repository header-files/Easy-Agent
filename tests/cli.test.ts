import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import type { AgentApplicationService } from '../src/application/index.ts';
import { AgentApplicationError } from '../src/application/index.ts';
import { runCli } from '../src/application/cli/index.ts';
import {
  resolveConfig,
  type EasyAgentApplication,
  type EasyAgentConfig,
  type LoadConfigOptions,
} from '../src/composition/index.ts';
import type { SessionExecution } from '../src/harness/contracts/agent/index.ts';
import type {
  ExecutionEvent,
  ExecutionResult,
} from '../src/harness/contracts/execution/index.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function io(input: Readable = Readable.from([])) {
  const text = { output: '', error: '' };
  return {
    input,
    output: new Writable({
      write(chunk, _encoding, done) {
        text.output += String(chunk);
        done();
      },
    }),
    error: new Writable({
      write(chunk, _encoding, done) {
        text.error += String(chunk);
        done();
      },
    }),
    text,
  };
}

function config(stream = true): EasyAgentConfig {
  return resolveConfig({
    fileConfig: {
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: 'https://provider.invalid/v1',
        },
      },
      models: ['fixture/offline', 'fixture/other'],
      defaultModel: 'fixture/offline',
      cli: { stream },
    },
  });
}

function completed(output: string): ExecutionResult {
  return { status: 'COMPLETED', loopResult: { status: 'completed', output } };
}

function observed(output: string, prefix = output): SessionExecution {
  return {
    executionId: 'execution',
    events: (async function* (): AsyncIterable<ExecutionEvent> {
      yield {
        type: 'loop_event',
        executionId: 'execution',
        event: {
          type: 'model_event',
          modelCallIndex: 1,
          event: { type: 'text_delta', text: prefix },
        },
      };
      yield {
        type: 'loop_event',
        executionId: 'execution',
        event: { type: 'output_delta', content: prefix },
      };
    })(),
    result: Promise.resolve(completed(output)),
  };
}

function application(
  submit: AgentApplicationService['submit'] = (_session, input) =>
    observed(input.toUpperCase()),
) {
  let created = 0;
  let disposed = 0;
  const models = new Map<string, string>();
  const submitted: { sessionId: string; input: string }[] = [];
  const cancelled: { sessionId: string; executionId: string }[] = [];
  const service: AgentApplicationService = {
    async createSession() {
      const sessionId = `session-${++created}`;
      models.set(sessionId, 'fixture/offline');
      return { sessionId };
    },
    listModels() {
      return [
        {
          id: 'fixture/offline',
          providerId: 'fixture',
          modelId: 'offline',
        },
        { id: 'fixture/other', providerId: 'fixture', modelId: 'other' },
      ];
    },
    getSessionModel(sessionId) {
      const model = models.get(sessionId);
      if (model === undefined) {
        throw new AgentApplicationError('session_not_found');
      }
      return model;
    },
    async setSessionModel(sessionId, modelId) {
      if (!['fixture/offline', 'fixture/other'].includes(modelId)) {
        throw new AgentApplicationError('invalid_input');
      }
      models.set(sessionId, modelId);
    },
    listSessions() {
      return [...models.keys()].map((sessionId) => ({
        sessionId,
        createdAt: '2026-11-26T00:00:00Z',
        queuedCount: 0,
      }));
    },
    async deleteSession() {
      return false;
    },
    listSessionExecutions() {
      return [];
    },
    getExecution() {
      return undefined;
    },
    submit(sessionId, input, options) {
      submitted.push({ sessionId, input });
      return submit(sessionId, input, options);
    },
    cancel(sessionId, executionId) {
      cancelled.push({ sessionId, executionId });
      return true;
    },
    registerWorkspace() {
      throw new AgentApplicationError('operation_failed');
    },
    createWorkspace() {
      throw new AgentApplicationError('operation_failed');
    },
    listWorkspaces() {
      return [];
    },
    getWorkspaceStatus() {
      throw new AgentApplicationError('session_not_found');
    },
    async recoverWorkspace() {},
    async removeWorkspace() {
      return false;
    },
    getSessionWorkspaceId() {
      return undefined;
    },
    getTerminalShell() {
      return '/bin/sh';
    },
    listPendingApprovals() {
      return [];
    },
    decideApproval() {
      throw new AgentApplicationError('invalid_input');
    },
    subscribeApprovals() {
      return () => {};
    },
  };
  const app: EasyAgentApplication = {
    service,
    async dispose() {
      disposed++;
    },
  };
  return {
    app,
    submitted,
    cancelled,
    currentModel(sessionId: string) {
      return models.get(sessionId);
    },
    get created() {
      return created;
    },
    get disposed() {
      return disposed;
    },
  };
}

test('CLI帮助和版本不解析模型配置、不装配应用或暴露环境', async () => {
  for (const args of [['--help'], [], ['--version']]) {
    const streams = io();
    let called = 0;
    const result = await runCli(args, {
      ...streams,
      env: { OPENAI_API_KEY: 'secret-not-for-display' },
      version: '1.2.3',
      async loadConfig() {
        called++;
        throw new Error();
      },
      async bootstrap() {
        called++;
        throw new Error();
      },
    });
    assert.equal(result, 0);
    assert.equal(called, 0);
    assert.equal(streams.text.error, '');
    assert.ok(!streams.text.output.includes('secret-not-for-display'));
    assert.match(
      streams.text.output,
      args[0] === '--version' ? /1.2.3/ : /用法/,
    );
  }
});

test('CLI选项仅映射到统一loadConfig，配置交给Bootstrap', async () => {
  const streams = io(Readable.from(['/exit\n']));
  const instance = application();
  let loaded: LoadConfigOptions | undefined;
  const env = { EASY_AGENT_DEFAULT_MODEL: 'fixture/offline' };
  const final = config(false);
  const result = await runCli(
    [
      'chat',
      '--config',
      'example.json',
      '--model',
      'fixture/other',
      '--max-model-retries',
      '0',
      '--no-stream',
    ],
    {
      ...streams,
      env,
      async loadConfig(options) {
        loaded = options;
        return final;
      },
      async bootstrap(value) {
        assert.equal(value, final);
        return instance.app;
      },
    },
  );
  assert.equal(result, 0);
  assert.deepEqual(loaded, {
    filePath: 'example.json',
    env,
    overrides: {
      defaultModel: 'fixture/other',
      agent: { maxModelRetries: 0 },
      cli: { stream: false },
    },
  });
  assert.equal(instance.disposed, 1);
});

test('CLI /model列出注册模型并只切换当前Session，无效选择保持原值', async () => {
  const streams = io(
    Readable.from([
      '/model\n/model fixture/other\n/model\n/new\n/model\n/model missing/x\n/model\n/exit\n',
    ]),
  );
  const instance = application();
  const result = await runCli(['chat'], {
    ...streams,
    async loadConfig() {
      return config();
    },
    async bootstrap() {
      return instance.app;
    },
  });
  assert.equal(result, 0);
  assert.equal(instance.currentModel('session-1'), 'fixture/other');
  assert.equal(instance.currentModel('session-2'), 'fixture/offline');
  assert.match(streams.text.output, /\* fixture\/other/);
  assert.match(streams.text.output, /\* fixture\/offline/);
  assert.match(streams.text.error, /模型未注册或标识无效/);
});

test('CLI /sessions 与 /session 可切回已有 Session', async () => {
  const streams = io(
    Readable.from([
      '/new\n/sessions\n/session session-1\nhello\n/session missing\n/exit\n',
    ]),
  );
  const instance = application();
  const result = await runCli(['chat'], {
    ...streams,
    async loadConfig() {
      return config();
    },
    async bootstrap() {
      return instance.app;
    },
  });
  assert.equal(result, 0);
  assert.match(streams.text.output, /\* session-2/);
  assert.match(streams.text.output, /已切换至 Session session-1/);
  assert.deepEqual(instance.submitted, [
    { sessionId: 'session-1', input: 'hello' },
  ]);
  assert.match(streams.text.error, /Session 不存在/);
});

test('CLI /session 支持唯一 ID 前缀；歧义前缀拒绝', async () => {
  const { resolveSessionIdQuery } =
    await import('../src/application/cli/run-cli.ts');
  const sessions = [
    { sessionId: '72aab98e-a78d-4fd7-997d-1525dc3869df' },
    { sessionId: '72bb0000-0000-4000-8000-000000000001' },
    { sessionId: 'a1111111-0000-4000-8000-000000000002' },
  ];
  assert.deepEqual(resolveSessionIdQuery('a111', sessions), {
    ok: true,
    sessionId: 'a1111111-0000-4000-8000-000000000002',
  });
  assert.deepEqual(resolveSessionIdQuery('72a', sessions), {
    ok: true,
    sessionId: '72aab98e-a78d-4fd7-997d-1525dc3869df',
  });
  assert.deepEqual(resolveSessionIdQuery('72', sessions), {
    ok: false,
    reason: 'ambiguous',
  });
  assert.deepEqual(
    resolveSessionIdQuery('72aab98e-a78d-4fd7-997d-1525dc3869df', sessions),
    {
      ok: true,
      sessionId: '72aab98e-a78d-4fd7-997d-1525dc3869df',
    },
  );
  assert.deepEqual(resolveSessionIdQuery('missing', sessions), {
    ok: false,
    reason: 'not_found',
  });

  const streams = io(
    Readable.from([
      '/new\n/session session-1\nping\n/session session-\n/session session-2\n/exit\n',
    ]),
  );
  const instance = application();
  const result = await runCli(['chat'], {
    ...streams,
    async loadConfig() {
      return config();
    },
    async bootstrap() {
      return instance.app;
    },
  });
  assert.equal(result, 0);
  assert.match(streams.text.output, /已切换至 Session session-1/);
  assert.match(streams.text.error, /前缀匹配到多个/);
  assert.match(streams.text.output, /已切换至 Session session-2/);
  assert.deepEqual(instance.submitted, [
    { sessionId: 'session-1', input: 'ping' },
  ]);
});

test('管道多轮、空行、未知命令、new与exit保持顺序，正文不重复打印', async () => {
  const streams = io(
    Readable.from(['one\n\n/unknown\ntwo\n/new\nthree\n/exit\nfour\n']),
  );
  const instance = application();
  const result = await runCli(['chat'], {
    ...streams,
    async loadConfig() {
      return config();
    },
    async bootstrap() {
      return instance.app;
    },
  });
  assert.equal(result, 0);
  assert.deepEqual(instance.submitted, [
    { sessionId: 'session-1', input: 'one' },
    { sessionId: 'session-1', input: 'two' },
    { sessionId: 'session-2', input: 'three' },
  ]);
  assert.equal(instance.created, 2);
  assert.equal(instance.disposed, 1);
  for (const answer of ['ONE', 'TWO', 'THREE'])
    assert.equal(streams.text.output.split(answer).length - 1, 1);
  assert.match(streams.text.error, /未知交互命令/);
  assert.deepEqual(instance.cancelled, []);
});

test(
  'CLI在result完成前实时输出，EOF不丢已收到的输入',
  { timeout: 2000 },
  async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const instance = application(() => ({
      executionId: 'execution',
      events: (async function* (): AsyncIterable<ExecutionEvent> {
        yield {
          type: 'loop_event',
          executionId: 'execution',
          event: { type: 'output_delta', content: 'live' },
        };
        entered.resolve();
        await release.promise;
      })(),
      result: release.promise.then(() => completed('live answer')),
    }));
    const streams = io(Readable.from(['first\n']));
    const pending = runCli(['chat'], {
      ...streams,
      async loadConfig() {
        return config();
      },
      async bootstrap() {
        return instance.app;
      },
    });
    await entered.promise;
    assert.match(streams.text.output, /live$/);
    assert.equal(instance.disposed, 0);
    release.resolve();
    assert.equal(await pending, 0);
    assert.match(streams.text.output, /live answer\n\[COMPLETED\]/);
    assert.equal(instance.disposed, 1);
  },
);

test('观察流失败后仍等待最终result并补缺失后缀，不取消执行', async () => {
  const streams = io(Readable.from(['first\n/exit\n']));
  const instance = application(() => ({
    executionId: 'execution',
    events: (async function* (): AsyncIterable<ExecutionEvent> {
      yield {
        type: 'loop_event',
        executionId: 'execution',
        event: { type: 'output_delta', content: 'partial' },
      };
      throw new Error('raw-secret-observation-error');
    })(),
    result: Promise.resolve(completed('partial complete')),
  }));
  assert.equal(
    await runCli(['chat'], {
      ...streams,
      async loadConfig() {
        return config();
      },
      async bootstrap() {
        return instance.app;
      },
    }),
    0,
  );
  assert.equal(streams.text.output.split('partial').length - 1, 1);
  assert.match(streams.text.output, /partial complete/);
  assert.match(streams.text.error, /事件观察中断/);
  assert.ok(!streams.text.error.includes('raw-secret'));
  assert.deepEqual(instance.cancelled, []);
});

test('最终结果与增量不一致时明确替换预览，no-stream只显示最终答案', async () => {
  for (const stream of [true, false]) {
    const streams = io(Readable.from(['first\n/exit\n']));
    const instance = application(() => observed('authoritative', 'preview'));
    assert.equal(
      await runCli(['chat'], {
        ...streams,
        async loadConfig() {
          return config(stream);
        },
        async bootstrap() {
          return instance.app;
        },
      }),
      0,
    );
    assert.equal(streams.text.output.split('authoritative').length - 1, 1);
    assert.equal(streams.text.output.includes('preview'), stream);
    assert.equal(streams.text.output.includes('替换此前预览'), stream);
  }
});

test('模型工具往返的前置文字与最终回答分开比较，最终正文不重复', async () => {
  const streams = io(Readable.from(['first\n/exit\n']));
  const instance = application(() => ({
    executionId: 'execution',
    events: (async function* (): AsyncIterable<ExecutionEvent> {
      for (const [index, text] of ['我来计算', '5'].entries()) {
        yield {
          type: 'loop_event',
          executionId: 'execution',
          event: {
            type: 'model_event',
            modelCallIndex: index + 1,
            event: { type: 'message_start', model: 'offline' },
          },
        };
        yield {
          type: 'loop_event',
          executionId: 'execution',
          event: { type: 'output_delta', content: text },
        };
      }
    })(),
    result: Promise.resolve(completed('5')),
  }));
  assert.equal(
    await runCli(['chat'], {
      ...streams,
      async loadConfig() {
        return config();
      },
      async bootstrap() {
        return instance.app;
      },
    }),
    0,
  );
  assert.match(streams.text.output, /我来计算\n5\n\[COMPLETED\]/);
  assert.equal(streams.text.output.split('5').length - 1, 1);
  assert.ok(!streams.text.output.includes('替换此前预览'));
});

test(
  'Bootstrap期间的退出等待装配完成再清理，清理失败保留失败退出码',
  { timeout: 2000 },
  async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const signals = new EventEmitter();
    const instance = application();
    let disposals = 0;
    instance.app.dispose = async () => {
      disposals++;
      throw new Error('private-cleanup-error');
    };
    const streams = io();
    const pending = runCli(['chat'], {
      ...streams,
      signals,
      async loadConfig() {
        return config();
      },
      async bootstrap() {
        entered.resolve();
        await release.promise;
        return instance.app;
      },
    });
    await entered.promise;
    signals.emit('SIGINT');
    signals.emit('SIGINT');
    assert.equal(disposals, 0);
    release.resolve();
    assert.equal(await pending, 1);
    assert.equal(instance.created, 0);
    assert.equal(disposals, 1);
    assert.match(streams.text.error, /资源清理失败/);
    assert.ok(!streams.text.error.includes('private-cleanup-error'));
    assert.equal(signals.listenerCount('SIGINT'), 0);
  },
);

test(
  'Ctrl+C显式取消一次并等待最终收尾，重复信号不重复dispose',
  { timeout: 2000 },
  async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const signals = new EventEmitter();
    const instance = application(() => ({
      executionId: 'execution',
      events: (async function* () {
        entered.resolve();
        await release.promise;
        yield* [];
      })(),
      result: release.promise.then(() => ({ status: 'CANCELLED' })),
    }));
    const streams = io(Readable.from(['first\n/exit\n']));
    const pending = runCli(['chat'], {
      ...streams,
      signals,
      async loadConfig() {
        return config();
      },
      async bootstrap() {
        return instance.app;
      },
    });
    await entered.promise;
    signals.emit('SIGINT');
    signals.emit('SIGINT');
    assert.deepEqual(instance.cancelled, [
      { sessionId: 'session-1', executionId: 'execution' },
    ]);
    assert.equal(instance.disposed, 0);
    release.resolve();
    assert.equal(await pending, 0);
    assert.match(streams.text.output, /\[CANCELLED\]/);
    assert.equal(instance.disposed, 1);
    assert.equal(signals.listenerCount('SIGINT'), 0);
  },
);

test('空闲Ctrl+C退出并移除信号处理', { timeout: 2000 }, async () => {
  const input = new PassThrough();
  const signals = new EventEmitter();
  const ready = deferred<void>();
  const streams = io(input);
  const instance = application();
  const original = instance.app.service.createSession;
  instance.app.service.createSession = (...args) => {
    const value = original(...args);
    setImmediate(() => ready.resolve());
    return value;
  };
  const pending = runCli(['chat'], {
    ...streams,
    signals,
    async loadConfig() {
      return config();
    },
    async bootstrap() {
      return instance.app;
    },
  });
  await ready.promise;
  signals.emit('SIGINT');
  assert.equal(await pending, 0);
  assert.equal(instance.disposed, 1);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  input.destroy();
});

test('FAILED和独立result拒绝不会伪装成功或泄漏原始错误', async () => {
  for (const reject of [false, true]) {
    const streams = io(Readable.from(['first\n/exit\n']));
    const instance = application(() => ({
      executionId: 'execution',
      events: (async function* () {
        await new Promise<void>((yes) => setImmediate(yes));
        yield* [];
      })(),
      result: reject
        ? Promise.reject(new Error('private-key-secret'))
        : Promise.resolve({
            status: 'FAILED',
            error: { code: 'loop_error', message: 'safe failure' },
          }),
    }));
    assert.equal(
      await runCli(['chat'], {
        ...streams,
        async loadConfig() {
          return config();
        },
        async bootstrap() {
          return instance.app;
        },
      }),
      1,
    );
    assert.match(
      streams.text.error,
      reject ? /无法获取最终结果/ : /FAILED: loop_error/,
    );
    assert.ok(!streams.text.error.includes('private-key-secret'));
    assert.ok(!streams.text.output.includes('[COMPLETED]'));
    assert.equal(instance.disposed, 1);
  }
});

test('无效CLI参数不启动，提交错误可继续，启动与清理错误安全呈现', async () => {
  for (const args of [
    ['unknown'],
    ['chat', '--model'],
    ['chat', '--max-model-retries', '-1'],
    ['chat', '--token', 'secret'],
  ]) {
    const streams = io();
    assert.equal(
      await runCli(args, {
        ...streams,
        async bootstrap() {
          throw new Error('must not start');
        },
      }),
      1,
    );
    assert.match(streams.text.error, /命令或选项无效/);
    assert.ok(!streams.text.error.includes('secret'));
  }
  const streams = io(Readable.from(['bad\ngood\n/exit\n']));
  const instance = application((_session, input) => {
    if (input === 'bad') throw new AgentApplicationError('invalid_input');
    return observed('OK');
  });
  instance.app.dispose = async () => {
    throw new Error('cleanup-secret');
  };
  assert.equal(
    await runCli(['chat'], {
      ...streams,
      async loadConfig() {
        return config();
      },
      async bootstrap() {
        return instance.app;
      },
    }),
    1,
  );
  assert.match(streams.text.error, /输入或会话选项无效/);
  assert.match(streams.text.error, /资源清理失败/);
  assert.match(streams.text.output, /OK\n\[COMPLETED\]/);
  assert.ok(!streams.text.error.includes('cleanup-secret'));
  const startup = io();
  assert.equal(
    await runCli(['chat'], {
      ...startup,
      async loadConfig() {
        throw new Error('startup-secret');
      },
    }),
    1,
  );
  assert.ok(!startup.text.error.includes('startup-secret'));
});
