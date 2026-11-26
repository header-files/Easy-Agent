import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AgentApplicationError,
  DefaultAgentApplicationService,
  type AgentApplicationErrorCode,
  type AgentApplicationService,
} from '../src/application/index.ts';
import type {
  AgentManager,
  CreateSessionOptions,
  SessionAgent,
  SessionExecution,
} from '../src/harness/contracts/agent/index.ts';
import type {
  AgentLoop,
  AgentLoopContext,
} from '../src/harness/contracts/agent-loop/index.ts';
import type { ModelCatalog } from '../src/harness/contracts/model/index.ts';
import { DefaultAgentManager } from '../src/agent/index.ts';
import { DefaultExecutionEngine } from '../src/execution/engine/index.ts';
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

const modelCatalog: ModelCatalog = {
  has(modelId) {
    return ['default', 'override', 'other'].includes(modelId);
  },
  list() {
    return [
      { id: 'default', providerId: 'fixture', modelId: 'default' },
      { id: 'override', providerId: 'fixture', modelId: 'override' },
      { id: 'other', providerId: 'fixture', modelId: 'other' },
    ];
  },
};

function application(
  agentManager: AgentManager,
  options: Omit<
    ConstructorParameters<typeof DefaultAgentApplicationService>[1],
    'modelCatalog'
  > = {},
) {
  return new DefaultAgentApplicationService(agentManager, {
    modelCatalog,
    ...options,
  });
}

function errorCode(code: AgentApplicationErrorCode) {
  return (error: unknown) =>
    error instanceof AgentApplicationError && error.code === code;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function manager(loop: AgentLoop): DefaultAgentManager {
  return new DefaultAgentManager(
    new DefaultExecutionEngine({ logger: quiet }),
    loop,
    { logger: quiet },
  );
}

const echo: AgentLoop = {
  async *run(context) {
    yield { type: 'loop_start' };
    yield {
      type: 'loop_end',
      result: {
        status: 'completed',
        output: context.input.content,
        updatedContext: {
          messages: [
            ...context.context.messages,
            { role: 'user', content: context.input.content },
            { role: 'assistant', content: context.input.content },
          ],
        },
      },
    };
  },
};

test('Service仅返回Session身份，原样透传提交句柄，可由非CLI适配器共享调用', async () => {
  const handle: SessionExecution = {
    executionId: 'execution',
    events: {
      async *[Symbol.asyncIterator]() {},
    },
    result: Promise.resolve({ status: 'CANCELLED' }),
  };
  const options: CreateSessionOptions = { context: { messages: [] } };
  const submitOptions = { config: { tools: { allowedNames: [] } } };
  let received: CreateSessionOptions | undefined;
  const session: SessionAgent = {
    sessionId: 'session',
    getModel() {
      return 'default';
    },
    setModel() {},
    submit(input, overrides) {
      assert.equal(input, 'from adapter');
      assert.equal(overrides, submitOptions);
      return handle;
    },
    cancel(executionId) {
      return executionId === 'execution';
    },
    getContext() {
      return { messages: [] };
    },
  };
  const summaries = [
    { sessionId: 'session', createdAt: '2026-11-24T00:00:00Z', queuedCount: 0 },
  ];
  const service: AgentApplicationService = application({
    createSession(value) {
      received = value;
      return session;
    },
    getSession(id) {
      return id === 'session' ? session : undefined;
    },
    listSessions() {
      return summaries;
    },
    async deleteSession() {
      return true;
    },
  });
  const identity = await service.createSession(options);
  assert.deepEqual(identity, { sessionId: 'session' });
  assert.ok(Object.isFrozen(identity));
  assert.equal(received?.context, options.context);
  assert.equal(service.listSessions(), summaries);
  const testAdapter = (app: AgentApplicationService) =>
    app.submit(identity.sessionId, 'from adapter', submitOptions);
  assert.equal(testAdapter(service), handle);
  assert.equal(service.cancel(identity.sessionId, handle.executionId), true);
  assert.equal(await service.deleteSession(identity.sessionId), true);
});

test('Service连续submit委托原FIFO，无观察者也运行且下一项继承最新成功上下文', async () => {
  const entered = deferred();
  const release = deferred();
  const starts: string[] = [];
  const histories: number[] = [];
  const app = application(
    manager({
      async *run(context) {
        starts.push(context.input.content);
        histories.push(context.context.messages.length);
        if (context.input.content === 'A') {
          entered.resolve();
          await release.promise;
        }
        yield* echo.run(context);
      },
    }),
  );
  const { sessionId } = await app.createSession();
  const first = app.submit(sessionId, 'A');
  const second = app.submit(sessionId, 'B');
  await entered.promise;
  assert.deepEqual(starts, ['A']);
  assert.equal(app.listSessions()[0]?.queuedCount, 1);
  release.resolve();
  assert.equal((await first.result).status, 'COMPLETED');
  assert.equal((await second.result).status, 'COMPLETED');
  assert.deepEqual(starts, ['A', 'B']);
  assert.deepEqual(histories, [0, 2]);
});

test('Service取消限定所属Session，不同Session执行并发且相互隔离', async () => {
  const firstEntered = deferred();
  const secondEntered = deferred();
  const release = deferred();
  const app = application(
    manager({
      async *run(context) {
        if (context.input.content === 'A') {
          firstEntered.resolve();
          await new Promise<void>((resolve) => {
            if (context.control.signal.aborted) resolve();
            else
              context.control.signal.addEventListener(
                'abort',
                () => resolve(),
                {
                  once: true,
                },
              );
          });
        } else {
          secondEntered.resolve();
          await release.promise;
        }
        yield* echo.run(context);
      },
    }),
  );
  const first = await app.createSession();
  const second = await app.createSession();
  const a = app.submit(first.sessionId, 'A');
  const b = app.submit(second.sessionId, 'B');
  await Promise.all([firstEntered.promise, secondEntered.promise]);
  assert.equal(app.cancel(second.sessionId, a.executionId), false);
  assert.equal(app.cancel(first.sessionId, a.executionId), true);
  assert.equal((await a.result).status, 'CANCELLED');
  assert.equal(app.listSessions()[1]?.runningExecutionId, b.executionId);
  release.resolve();
  assert.equal((await b.result).status, 'COMPLETED');
  assert.equal(app.cancel(first.sessionId, a.executionId), false);
});

test('Service保留忙碌删除false，空闲删除后缺失身份稳定报错且不误建Session', async () => {
  const instance = manager(echo);
  const app = application(instance);
  const { sessionId } = await app.createSession();
  const held = instance.getSession(sessionId)!;
  const handle = app.submit(sessionId, 'A');
  assert.equal(await app.deleteSession(sessionId), false);
  await handle.result;
  assert.equal(await app.deleteSession(sessionId), true);
  assert.throws(() => held.submit('B'), /closed/);
  assert.throws(
    () => app.submit(sessionId, 'B'),
    errorCode('session_not_found'),
  );
  assert.throws(
    () => app.cancel(sessionId, handle.executionId),
    errorCode('session_not_found'),
  );
  await assert.rejects(
    app.deleteSession(sessionId),
    errorCode('session_not_found'),
  );
  assert.deepEqual(app.listSessions(), []);
});

test('应用级无效输入固定分类，不向Manager提交或把任意输入写入异常', async () => {
  const app = application(manager(echo));
  const { sessionId } = await app.createSession();
  for (const input of ['', ' \n\t', 42, null])
    assert.throws(
      () => app.submit(sessionId, input as string),
      errorCode('invalid_input'),
    );
  for (const id of ['', '  ', 42, null]) {
    assert.throws(
      () => app.submit(id as string, 'A'),
      errorCode('invalid_input'),
    );
    assert.throws(
      () => app.cancel(sessionId, id as string),
      errorCode('invalid_input'),
    );
  }
  await assert.rejects(
    () =>
      app.createSession({
        config: { model: { name: 42 as unknown as string } },
      }),
    errorCode('invalid_input'),
  );
  assert.throws(
    () =>
      app.submit(sessionId, 'A', {
        config: { tools: { allowedNames: [42 as unknown as string] } },
      }),
    errorCode('invalid_input'),
  );
  assert.equal(app.listSessions()[0]?.queuedCount, 0);
  assert.equal(app.listSessions()[0]?.runningExecutionId, undefined);
});

test('Service默认Session配置按既有参数键/名单/namespace规则覆盖，不修改入参', async () => {
  const contexts: AgentLoopContext[] = [];
  const defaults: CreateSessionOptions = {
    config: {
      model: {
        name: 'default',
        parameters: { temperature: 0.1, maxOutputTokens: 50 },
      },
      tools: { allowedNames: ['add'] },
      extensions: {
        defaultAgentLoop: { maxModelRetries: 2, other: true },
        kept: { version: 1 },
      },
    },
  };
  const overrides: CreateSessionOptions = {
    config: {
      model: { name: 'override', parameters: { temperature: 0.7 } },
      tools: { allowedNames: [] },
      extensions: { defaultAgentLoop: { maxModelRetries: 0 } },
    },
  };
  const originalDefaults = structuredClone(defaults);
  const originalOverrides = structuredClone(overrides);
  const app = application(
    manager({
      async *run(context) {
        contexts.push(context);
        yield* echo.run(context);
      },
    }),
    { defaultSessionOptions: defaults },
  );
  const first = await app.createSession(overrides);
  const second = await app.createSession();
  await app.submit(first.sessionId, 'A').result;
  await app.submit(second.sessionId, 'B').result;
  assert.deepEqual(contexts[0]?.config, {
    model: {
      name: 'override',
      parameters: { temperature: 0.7, maxOutputTokens: 50 },
    },
    tools: { allowedNames: [] },
    extensions: {
      defaultAgentLoop: { maxModelRetries: 0 },
      kept: { version: 1 },
    },
  });
  assert.deepEqual(contexts[1]?.config, defaults.config);
  assert.deepEqual(defaults, originalDefaults);
  assert.deepEqual(overrides, originalOverrides);
});

test('Service无模型配置支持CustomLoop，错误边界不泄露底层异常和配置', async () => {
  const rawSecret = 'secret-that-must-not-escape';
  const fault = () => {
    throw new Error(rawSecret);
  };
  const broken: AgentManager = {
    createSession: fault,
    getSession: fault,
    listSessions: fault,
    deleteSession: fault,
  };
  const app = application(broken);
  await assert.rejects(app.createSession(), (error: unknown) => {
    assert.ok(error instanceof AgentApplicationError);
    assert.equal(error.code, 'operation_failed');
    assert.ok(!error.message.includes(rawSecret));
    assert.ok(!error.stack?.includes(rawSecret));
    assert.equal(error.cause, undefined);
    return true;
  });
  for (const operation of [
    () => app.listSessions(),
    () => app.submit('id', 'A'),
    () => app.cancel('id', 'execution'),
  ]) {
    assert.throws(operation, (error: unknown) => {
      assert.ok(error instanceof AgentApplicationError);
      assert.equal(error.code, 'operation_failed');
      assert.ok(!error.message.includes(rawSecret));
      assert.ok(!error.stack?.includes(rawSecret));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  await assert.rejects(app.deleteSession('id'), errorCode('operation_failed'));
  const custom = application(manager(echo));
  const identity = await custom.createSession();
  assert.equal(
    (await custom.submit(identity.sessionId, 'custom').result).status,
    'COMPLETED',
  );
});

test('Service列出模型并按Execution>Session>Application固定提交模型，切换不影响已排队任务', async () => {
  const seen: string[] = [];
  const firstStarted = deferred();
  const release = deferred();
  const app = application(
    manager({
      async *run(context) {
        seen.push(context.config.model?.name ?? '');
        if (context.input.content === 'E1') {
          firstStarted.resolve();
          await release.promise;
        }
        yield* echo.run(context);
      },
    }),
    {
      defaultSessionOptions: {
        config: { model: { name: 'default' } },
      },
    },
  );
  assert.deepEqual(
    app.listModels().map((model) => model.id),
    ['default', 'override', 'other'],
  );
  const first = await app.createSession();
  const second = await app.createSession({
    config: { model: { name: 'other' } },
  });
  assert.equal(app.getSessionModel(first.sessionId), 'default');
  assert.equal(app.getSessionModel(second.sessionId), 'other');
  const e1 = app.submit(first.sessionId, 'E1');
  await firstStarted.promise;
  await app.setSessionModel(first.sessionId, 'override');
  assert.equal(app.getSessionModel(first.sessionId), 'override');
  await assert.rejects(
    () => app.setSessionModel(first.sessionId, 'missing/model'),
    errorCode('invalid_input'),
  );
  assert.equal(app.getSessionModel(first.sessionId), 'override');
  const e2 = app.submit(first.sessionId, 'E2');
  const e3 = app.submit(first.sessionId, 'E3', {
    config: { model: { name: 'other' } },
  });
  assert.equal(app.getSessionModel(first.sessionId), 'override');
  release.resolve();
  assert.equal((await e1.result).status, 'COMPLETED');
  assert.equal((await e2.result).status, 'COMPLETED');
  assert.equal((await e3.result).status, 'COMPLETED');
  assert.deepEqual(seen, ['default', 'override', 'other']);
  const other = app.submit(second.sessionId, 'isolated');
  assert.equal((await other.result).status, 'COMPLETED');
  assert.deepEqual(seen, ['default', 'override', 'other', 'other']);
});
