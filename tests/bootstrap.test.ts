import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentApplicationError } from '../src/application/index.ts';
import { DefaultAgentManager } from '../src/agent/index.ts';
import { DefaultExecutionEngine } from '../src/execution/engine/index.ts';
import {
  bootstrap,
  BootstrapError,
  resolveConfig,
} from '../src/composition/index.ts';
import type {
  AgentLoop,
  AgentLoopContext,
} from '../src/harness/contracts/agent-loop/index.ts';
import type {
  ModelClient,
  ModelRequest,
  ModelStreamEvent,
} from '../src/harness/contracts/model/index.ts';
import { createLogger } from '../src/runtime/logging/index.ts';

const logger = createLogger({ destination: { write() {} } });
const config = () =>
  resolveConfig({ fileConfig: { model: { name: 'offline' } } });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function textModel(seen: ModelRequest[] = []): ModelClient {
  return {
    generate() {
      throw new Error('only stream');
    },
    async *stream(request) {
      seen.push(request);
      yield { type: 'message_start', model: request.model };
      yield { type: 'text_delta', text: 'answer' };
      yield {
        type: 'message_end',
        response: {
          model: request.model,
          message: { role: 'assistant', content: 'answer' },
          finishReason: 'stop',
        },
      };
    },
  };
}

test('Bootstrap默认装配不发网络，注入Model贯通多轮上下文与Session隔离', async () => {
  const direct = await bootstrap(config(), { logger });
  assert.equal(direct.service.listSessions().length, 0);
  await direct.dispose();
  const seen: ModelRequest[] = [];
  const app = await bootstrap(config(), {
    modelClient: textModel(seen),
    logger,
  });
  try {
    const session = app.service.createSession();
    const first = app.service.submit(session.sessionId, 'one');
    const second = app.service.submit(session.sessionId, 'two');
    assert.equal((await first.result).status, 'COMPLETED');
    assert.equal((await second.result).status, 'COMPLETED');
    const other = app.service.createSession();
    await app.service.submit(other.sessionId, 'isolated').result;
    assert.deepEqual(
      seen.map((request) => request.messages.map((message) => message.content)),
      [['one'], ['one', 'answer', 'two'], ['isolated']],
    );
    assert.ok(seen.every((request) => request.model === 'offline'));
  } finally {
    await app.dispose();
  }
});

test(
  '退出取消运行与排队任务，等待公开迭代器清理后释放自有资源且dispose幂等',
  { timeout: 3000 },
  async () => {
    const entered = deferred();
    const cleaning = deferred();
    const release = deferred();
    let disposed = 0;
    const app = await bootstrap(config(), {
      logger,
      createModelClient: () => ({
        client: {
          generate() {
            throw new Error();
          },
          async *stream(request, options): AsyncIterable<ModelStreamEvent> {
            try {
              entered.resolve();
              await new Promise<void>((resolve) => {
                if (options?.signal?.aborted) resolve();
                else
                  options?.signal?.addEventListener('abort', () => resolve(), {
                    once: true,
                  });
              });
              yield { type: 'message_start', model: request.model };
            } finally {
              cleaning.resolve();
              await release.promise;
            }
          },
        },
        dispose() {
          disposed++;
        },
      }),
    });
    const session = app.service.createSession();
    const first = app.service.submit(session.sessionId, 'running');
    const queued = app.service.submit(session.sessionId, 'queued');
    await entered.promise;
    const closing = app.dispose();
    assert.equal(closing, app.dispose());
    assert.throws(
      () => app.service.submit(session.sessionId, 'late'),
      (error: unknown) =>
        error instanceof AgentApplicationError &&
        error.code === 'application_disposed',
    );
    assert.equal((await queued.result).status, 'CANCELLED');
    // DefaultLoop owns best-effort model cleanup; test public Loop cleanup separately below.
    await cleaning.promise;
    release.resolve();
    await closing;
    assert.equal((await first.result).status, 'CANCELLED');
    assert.equal(disposed, 1);
    await app.dispose();
    assert.equal(disposed, 1);
  },
);

test(
  '自定义Loop取消保持协作清理边界，不提前完成dispose，不误释放外部共享组件',
  { timeout: 3000 },
  async () => {
    const entered = deferred();
    const cleaning = deferred();
    const release = deferred();
    let finalized = false;
    const contexts: AgentLoopContext[] = [];
    const loop: AgentLoop = {
      async *run(context) {
        contexts.push(context);
        try {
          yield { type: 'loop_start' };
          entered.resolve();
          await new Promise<void>((resolve) =>
            context.control.signal.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          );
        } finally {
          cleaning.resolve();
          await release.promise;
          finalized = true;
        }
      },
    };
    const app = await bootstrap(config(), { loop, logger });
    const session = app.service.createSession();
    const execution = app.service.submit(session.sessionId, 'work');
    await entered.promise;
    let settled = false;
    const closing = app.dispose().then(() => {
      settled = true;
    });
    await cleaning.promise;
    assert.equal(settled, false);
    assert.equal(finalized, false);
    assert.equal(
      contexts[0]?.config.extensions?.defaultAgentLoop !== undefined,
      true,
    );
    assert.equal(JSON.stringify(contexts[0]?.config).includes('apiKey'), false);
    release.resolve();
    await closing;
    assert.equal(finalized, true);
    assert.equal((await execution.result).status, 'CANCELLED');
  },
);

test('初始化中途失败逆序回滚owned Model；共享注入不自动释放，失败消息不泄密', async () => {
  let released = 0;
  await assert.rejects(
    bootstrap(config(), {
      logger,
      createModelClient: () => ({
        client: textModel(),
        dispose() {
          released++;
        },
      }),
      tools: [
        {
          spec: {
            name: 'add',
            description: 'duplicate',
            parameters: { type: 'object' },
          },
          handler() {
            return { content: '' };
          },
        },
      ],
    }),
    (error: unknown) =>
      error instanceof BootstrapError && error.stage === 'tools',
  );
  assert.equal(released, 1);
  const client = Object.assign(textModel(), {
    dispose() {
      released++;
    },
  });
  const app = await bootstrap(config(), { modelClient: client, logger });
  await app.dispose();
  assert.equal(released, 1);
  await assert.rejects(
    bootstrap(config(), {
      logger,
      createModelClient() {
        throw new Error('private-key-never-output');
      },
    }),
    (error: unknown) =>
      error instanceof BootstrapError &&
      error.stage === 'model' &&
      !String(error.stack).includes('private-key-never-output'),
  );
});

test('资源释放失败仍只执行一次并返回稳定安全错误', async () => {
  let releases = 0;
  const app = await bootstrap(config(), {
    logger,
    createModelClient: () => ({
      client: textModel(),
      dispose() {
        releases++;
        throw new Error('private-release-value');
      },
    }),
  });
  const closing = app.dispose();
  await assert.rejects(
    closing,
    (error: unknown) =>
      error instanceof BootstrapError &&
      error.code === 'cleanup_failed' &&
      !String(error.stack).includes('private-release-value'),
  );
  assert.equal(closing, app.dispose());
  await assert.rejects(app.dispose(), BootstrapError);
  assert.equal(releases, 1);
});

test('dispose在外部cancel重入时也使用同一Promise；owned无效Model回滚已捕获释放函数', async () => {
  const entered = deferred();
  const loop: AgentLoop = {
    async *run(context) {
      yield { type: 'loop_start' };
      entered.resolve();
      await new Promise<void>((resolve) =>
        context.control.signal.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      );
    },
  };
  const manager = new DefaultAgentManager(
    new DefaultExecutionEngine({ logger }),
    loop,
    { logger },
  );
  const create = manager.createSession.bind(manager);
  let reentered: Promise<void> | undefined;
  manager.createSession = (options) => {
    const session = create(options);
    const cancel = session.cancel.bind(session);
    session.cancel = (id) => {
      reentered = app.dispose();
      return cancel(id);
    };
    return session;
  };
  const app = await bootstrap(config(), { manager, logger });
  const session = app.service.createSession();
  const work = app.service.submit(session.sessionId, 'work');
  await entered.promise;
  const closing = app.dispose();
  await closing;
  assert.equal(reentered, closing);
  assert.equal((await work.result).status, 'CANCELLED');
  let released = 0;
  await assert.rejects(
    bootstrap(config(), {
      logger,
      createModelClient: () => ({
        client: {} as ModelClient,
        dispose() {
          released++;
        },
      }),
    }),
    BootstrapError,
  );
  assert.equal(released, 1);
  const owned = {
    client: textModel(),
    dispose() {
      released++;
    },
  };
  const second = await bootstrap(config(), {
    logger,
    createModelClient: () => owned,
  });
  owned.dispose = () => {
    throw new Error('changed-later');
  };
  await second.dispose();
  assert.equal(released, 2);
});
