import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { DefaultSessionAgent } from '../src/agent/default-session-agent.ts';
import { bootstrap } from '../src/composition/bootstrap.ts';
import { resolveConfig } from '../src/composition/config.ts';
import type { ModelClient } from '../src/harness/contracts/model/index.ts';
import { createLogger } from '../src/runtime/logging/index.ts';
import {
  openPersistenceRuntime,
  PersistenceBridge,
  PersistenceError,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  resolveLayout,
  sessionEventsPath,
} from '../src/runtime/persistence/index.ts';

const logger = createLogger({ destination: { write() {} } });

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'ea-p24-'));
}

function mockClient(replies: string[]): ModelClient {
  let index = 0;
  return {
    generate() {
      throw new Error('generate unused');
    },
    async *stream() {
      const text = replies[Math.min(index, replies.length - 1)] ?? 'ok';
      index++;
      yield { type: 'message_start', model: 'm1' };
      yield { type: 'text_delta', text };
      yield {
        type: 'message_end',
        response: {
          model: 'm1',
          message: { role: 'assistant', content: text },
          finishReason: 'stop',
        },
      };
    },
  };
}

function baseConfig(dataDir: string) {
  return resolveConfig({
    fileConfig: {
      providers: {
        local: {
          type: 'openai-compatible',
          baseURL: 'http://127.0.0.1:9',
          apiKey: 'test-key',
        },
      },
      models: ['local/m1', 'local/m2'],
      defaultModel: 'local/m1',
      persistence: { dataDir },
    },
  });
}

function withClient(client: ModelClient) {
  return {
    logger,
    providerFactories: {
      'openai-compatible': () => ({ client }),
    },
  };
}

test('Session 续聊：成功两轮后重启，历史与模型保留且无重复', async () => {
  const root = await tempRoot();
  try {
    const app1 = await bootstrap(
      baseConfig(root),
      withClient(mockClient(['one', 'two', 'three'])),
    );
    let sessionId: string;
    try {
      sessionId = (await app1.service.createSession()).sessionId;
      assert.equal(
        (await app1.service.submit(sessionId, 'hello').result).status,
        'COMPLETED',
      );
      assert.equal(
        (await app1.service.submit(sessionId, 'again').result).status,
        'COMPLETED',
      );
      await app1.service.setSessionModel(sessionId, 'local/m2');
      assert.equal(app1.service.getSessionModel(sessionId), 'local/m2');
    } finally {
      await app1.dispose();
    }

    const app2 = await bootstrap(
      baseConfig(root),
      withClient(mockClient(['three'])),
    );
    try {
      const sessions = app2.service.listSessions();
      assert.equal(sessions.length, 1);
      sessionId = sessions[0]!.sessionId;
      assert.equal(app2.service.getSessionModel(sessionId), 'local/m2');
      const result = await app2.service.submit(sessionId, 'third').result;
      assert.equal(result.status, 'COMPLETED');
      if (result.status === 'COMPLETED') {
        const messages = result.loopResult.updatedContext?.messages ?? [];
        const users = messages.filter((m) => m.role === 'user');
        assert.equal(users.length, 3);
        assert.deepEqual(
          users.map((m) => (m.role === 'user' ? m.content : '')),
          ['hello', 'again', 'third'],
        );
      }
    } finally {
      await app2.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('冷启动后普通 refresh 在 interrupted_detected 前保留 INTERRUPTED', async () => {
  const root = await tempRoot();
  try {
    const seed = await openPersistenceRuntime(root);
    await seed.commitSessionEvents('s-refresh-int', [
      { type: 'session/created', payload: { model: 'local/m1' } },
      {
        type: 'execution/created',
        payload: {
          executionId: 'e-refresh',
          input: 'pending',
          model: 'local/m1',
        },
        executionId: 'e-refresh',
      },
      {
        type: 'execution/started',
        payload: { executionId: 'e-refresh' },
        executionId: 'e-refresh',
      },
    ]);
    await seed.dispose();

    const runtime = await openPersistenceRuntime(root);
    try {
      assert.equal(
        runtime.projections.executions.get('e-refresh')?.status,
        'INTERRUPTED',
      );
      assert.equal(
        runtime.projections.executions.get('e-refresh')?.needsInterruptPersist,
        true,
      );
      // Simulate Bootstrap registering a Workspace (refresh without interruptUnfinished).
      await runtime.commitWorkspaceRecords([
        {
          type: 'workspace/registered',
          payload: {
            workspaceId: 'w-refresh',
            name: 'w',
            rootPath: root,
          },
        },
      ]);
      await runtime.refreshProjections();
      assert.equal(
        runtime.projections.executions.get('e-refresh')?.status,
        'INTERRUPTED',
      );
      assert.equal(
        runtime.projections.executions.get('e-refresh')?.needsInterruptPersist,
        true,
      );
    } finally {
      await runtime.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('Bootstrap 登记 Workspace 后仍保留冷启动 INTERRUPTED', async () => {
  const root = await tempRoot();
  const workspaceDir = await mkdtemp(path.join(tmpdir(), 'ea-p24-ws-'));
  try {
    const runtime = await openPersistenceRuntime(root);
    const bridge = new PersistenceBridge(runtime);
    await bridge.requireSessionEvents('s-boot-int', [
      { type: 'session/created', payload: { model: 'local/m1' } },
      {
        type: 'execution/created',
        payload: {
          executionId: 'e-boot',
          input: 'pending',
          model: 'local/m1',
        },
        executionId: 'e-boot',
      },
      {
        type: 'execution/started',
        payload: { executionId: 'e-boot' },
        executionId: 'e-boot',
      },
    ]);
    await bridge.dispose();

    const app = await bootstrap(
      {
        ...baseConfig(root),
        workspace: { path: workspaceDir },
      },
      withClient(mockClient(['ok'])),
    );
    try {
      const info = app.service.getExecution('s-boot-int', 'e-boot');
      assert.equal(info?.status, 'INTERRUPTED');
      const listed = app.service.listSessionExecutions('s-boot-int');
      assert.equal(
        listed.find((item) => item.executionId === 'e-boot')?.status,
        'INTERRUPTED',
      );
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await rm(workspaceDir, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
});

test('含 Date/Map 的 context.data 创建 Session 被拒绝', async () => {
  const root = await tempRoot();
  try {
    const { AgentApplicationError } =
      await import('../src/application/agent-application-service.ts');
    const app = await bootstrap(
      baseConfig(root),
      withClient(mockClient(['unused'])),
    );
    try {
      await assert.rejects(
        () =>
          app.service.createSession({
            context: {
              messages: [],
              data: { when: new Date('2024-01-01T00:00:00.000Z') },
            },
          }),
        (error: unknown) =>
          error instanceof AgentApplicationError &&
          error.code === 'operation_failed',
      );
      await assert.rejects(
        () =>
          app.service.createSession({
            context: {
              messages: [],
              data: { bag: new Map([['a', 1]]) },
            },
          }),
        (error: unknown) =>
          error instanceof AgentApplicationError &&
          error.code === 'operation_failed',
      );
      const ok = await app.service.createSession({
        context: {
          messages: [{ role: 'user', content: 'plain' }],
          data: { marker: 'ok', nested: { n: 1 } },
        },
      });
      assert.ok(ok.sessionId);
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('进程内 Projection 刷新不得把活跃 Execution 标为 INTERRUPTED', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    try {
      await runtime.commitSessionEvents('s-live', [
        { type: 'session/created', payload: { model: 'local/m1' } },
        {
          type: 'execution/created',
          payload: {
            executionId: 'e-created',
            input: 'c',
            model: 'local/m1',
          },
          executionId: 'e-created',
        },
        {
          type: 'execution/created',
          payload: {
            executionId: 'e-started',
            input: 's',
            model: 'local/m1',
          },
          executionId: 'e-started',
        },
        {
          type: 'execution/started',
          payload: { executionId: 'e-started' },
          executionId: 'e-started',
        },
      ]);
      await runtime.refreshProjections();
      assert.equal(
        runtime.projections.executions.get('e-created')?.status,
        'CREATED',
      );
      assert.equal(
        runtime.projections.executions.get('e-started')?.status,
        'STARTED',
      );
      assert.equal(
        runtime.projections.executions.get('e-created')?.interrupted,
        undefined,
      );
    } finally {
      await runtime.dispose();
    }

    const cold = await openPersistenceRuntime(root);
    try {
      assert.equal(
        cold.projections.executions.get('e-created')?.status,
        'INTERRUPTED',
      );
      assert.equal(
        cold.projections.executions.get('e-started')?.status,
        'INTERRUPTED',
      );
      assert.equal(
        cold.projections.executions.get('e-started')?.needsInterruptPersist,
        true,
      );
    } finally {
      await cold.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('恢复 Session 保留 Context data', async () => {
  const root = await tempRoot();
  try {
    const app1 = await bootstrap(
      baseConfig(root),
      withClient(mockClient(['unused'])),
    );
    let sessionId: string;
    try {
      sessionId = (
        await app1.service.createSession({
          context: {
            messages: [{ role: 'user', content: 'seed' }],
            data: { marker: 'keep-me', nested: { n: 1 } },
          },
        })
      ).sessionId;
    } finally {
      await app1.dispose();
    }

    const stored = await openPersistenceRuntime(root);
    try {
      const projection = stored.projections.sessions.get(sessionId);
      assert.ok(projection?.initialContext?.data);
      assert.equal(projection.initialContext?.data?.marker, 'keep-me');
      assert.deepEqual(projection.initialContext?.data?.nested, { n: 1 });
    } finally {
      await stored.dispose();
    }

    let seenMarker: unknown;
    let seenNested: unknown;
    const app2 = await bootstrap(baseConfig(root), {
      logger,
      providerFactories: {
        'openai-compatible': () => ({ client: mockClient(['ok']) }),
      },
      loop: {
        async *run(context) {
          seenMarker = context.context.data?.marker;
          seenNested = context.context.data?.nested;
          yield { type: 'loop_start' };
          yield {
            type: 'loop_end',
            result: {
              status: 'completed',
              output: 'ok',
              updatedContext: {
                messages: [
                  ...context.context.messages,
                  { role: 'user', content: context.input.content },
                  { role: 'assistant', content: 'ok' },
                ],
                ...(context.context.data === undefined
                  ? {}
                  : { data: context.context.data }),
              },
            },
          };
        },
      },
    });
    try {
      assert.ok(
        app2.service.listSessions().some((s) => s.sessionId === sessionId),
      );
      assert.equal(
        (await app2.service.submit(sessionId, 'ping').result).status,
        'COMPLETED',
      );
      assert.equal(seenMarker, 'keep-me');
      assert.deepEqual(seenNested, { n: 1 });
    } finally {
      await app2.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('未完成 Execution 冷启动识别中断且不自动入队', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    const bridge = new PersistenceBridge(runtime);
    await bridge.requireSessionEvents('s-int', [
      { type: 'session/created', payload: { model: 'local/m1' } },
      {
        type: 'user/message',
        payload: { content: 'pending' },
        executionId: 'e-run',
      },
      {
        type: 'execution/created',
        payload: {
          executionId: 'e-run',
          input: 'pending',
          model: 'local/m1',
        },
        executionId: 'e-run',
      },
      {
        type: 'execution/started',
        payload: { executionId: 'e-run' },
        executionId: 'e-run',
      },
    ]);
    await bridge.dispose();

    const check = await openPersistenceRuntime(root);
    try {
      const execution = check.projections.executions.get('e-run');
      assert.equal(execution?.status, 'INTERRUPTED');
      assert.equal(execution?.interrupted, true);
      assert.equal(execution?.needsInterruptPersist, true);
    } finally {
      await check.dispose();
    }

    const app = await bootstrap(
      baseConfig(root),
      withClient(mockClient(['fresh'])),
    );
    try {
      const sessionId = app.service.listSessions()[0]!.sessionId;
      const next = app.service.submit(sessionId, 'new-work');
      assert.equal((await next.result).status, 'COMPLETED');
      assert.notEqual(next.executionId, 'e-run');
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await rm(root, { recursive: true, force: true });
    });
  }
});

test('Execution 模型在提交时固定，Session 切换不影响历史 Execution', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    const bridge = new PersistenceBridge(runtime);
    await bridge.requireSessionEvents('s-model', [
      { type: 'session/created', payload: { model: 'local/m1' } },
      {
        type: 'execution/created',
        payload: {
          executionId: 'e1',
          input: 'x',
          model: 'local/m1',
        },
        executionId: 'e1',
      },
      {
        type: 'execution/completed',
        payload: {
          executionId: 'e1',
          messages: [
            { role: 'user', content: 'x', executionId: 'e1' },
            { role: 'assistant', content: 'y', executionId: 'e1' },
          ],
        },
        executionId: 'e1',
      },
      { type: 'session/model_changed', payload: { model: 'local/m2' } },
    ]);
    await runtime.refreshProjections();
    assert.equal(runtime.projections.executions.get('e1')?.model, 'local/m1');
    assert.equal(
      runtime.projections.sessions.get('s-model')?.model,
      'local/m2',
    );
    await bridge.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('失败 Execution 事实可查但不进入 Message Projection', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    await runtime.commitSessionEvents('s-fail', [
      { type: 'session/created', payload: { model: 'local/m1' } },
      {
        type: 'execution/created',
        payload: { executionId: 'ok', input: 'a', model: 'local/m1' },
        executionId: 'ok',
      },
      {
        type: 'execution/completed',
        payload: {
          executionId: 'ok',
          messages: [
            { role: 'user', content: 'a', executionId: 'ok' },
            { role: 'assistant', content: 'A', executionId: 'ok' },
          ],
        },
        executionId: 'ok',
      },
      {
        type: 'execution/created',
        payload: { executionId: 'bad', input: 'b', model: 'local/m1' },
        executionId: 'bad',
      },
      {
        type: 'execution/failed',
        payload: { executionId: 'bad', error: { code: 'loop_error' } },
        executionId: 'bad',
      },
      {
        type: 'execution/created',
        payload: { executionId: 'ok2', input: 'c', model: 'local/m1' },
        executionId: 'ok2',
      },
      {
        type: 'execution/completed',
        payload: {
          executionId: 'ok2',
          messages: [
            { role: 'user', content: 'c', executionId: 'ok2' },
            { role: 'assistant', content: 'C', executionId: 'ok2' },
          ],
        },
        executionId: 'ok2',
      },
    ]);
    await runtime.refreshProjections();
    assert.equal(runtime.projections.executions.get('bad')?.status, 'FAILED');
    const messages = runtime.projections.messagesBySession.get('s-fail') ?? [];
    assert.equal(
      messages.some((m) => m.executionId === 'bad'),
      false,
    );
    assert.deepEqual(
      messages.filter((m) => m.role === 'user').map((m) => m.content),
      ['a', 'c'],
    );
    await runtime.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Workspace UNSAFE 与 terminal_intent 跨重启保留；人工恢复覆盖边界', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    await runtime.commitWorkspaceRecords([
      {
        type: 'workspace/registered',
        payload: {
          workspaceId: 'w1',
          name: 'default',
          rootPath: root,
        },
      },
      {
        type: 'workspace/terminal_intent',
        payload: { activityId: 'act-1', workspaceId: 'w1' },
      },
    ]);
    await runtime.refreshProjections();
    assert.equal(runtime.projections.workspaces.get('w1')?.safety, 'UNSAFE');
    await runtime.dispose();

    const again = await openPersistenceRuntime(root);
    assert.equal(again.projections.workspaces.get('w1')?.safety, 'UNSAFE');
    await again.commitWorkspaceRecords([
      {
        type: 'workspace/recovered',
        payload: {
          workspaceId: 'w1',
          coveredActivityIds: ['act-1'],
        },
      },
    ]);
    await again.refreshProjections();
    assert.equal(again.projections.workspaces.get('w1')?.safety, 'NORMAL');
    await again.dispose();

    const third = await openPersistenceRuntime(root);
    assert.equal(third.projections.workspaces.get('w1')?.safety, 'NORMAL');
    await third.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('被 Session 引用的 Workspace 删除被拒', async () => {
  const root = await tempRoot();
  try {
    const app = await bootstrap(
      { ...baseConfig(root), workspace: { path: root } },
      withClient(mockClient(['ok'])),
    );
    try {
      const { sessionId } = await app.service.createSession();
      const workspaceId = app.service.getSessionWorkspaceId(sessionId);
      assert.ok(workspaceId);
      await assert.rejects(
        () => app.service.removeWorkspace(workspaceId!),
        (error: unknown) =>
          error instanceof Error &&
          'code' in error &&
          (error as { code: string }).code === 'operation_failed',
      );
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('写锁互斥：第二进程打开同一 dataDir 失败', async () => {
  const root = await tempRoot();
  try {
    const first = await openPersistenceRuntime(root);
    await assert.rejects(
      () => openPersistenceRuntime(root),
      (error: unknown) =>
        error instanceof PersistenceError && error.code === 'lock_failed',
    );
    await first.dispose();
    const second = await openPersistenceRuntime(root);
    await second.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Session 创建与模型切换仅在提交成功后对外生效', async () => {
  const root = await tempRoot();
  try {
    const app = await bootstrap(
      baseConfig(root),
      withClient(mockClient(['ok'])),
    );
    try {
      const { sessionId } = await app.service.createSession();
      // createSession resolved ⇒ session/created already committed.
      await app.dispose();
      const check = await openPersistenceRuntime(root);
      try {
        assert.equal(
          check.projections.sessions.get(sessionId)?.model,
          'local/m1',
        );
      } finally {
        await check.dispose();
      }

      const app2 = await bootstrap(
        baseConfig(root),
        withClient(mockClient(['ok'])),
      );
      try {
        await app2.service.setSessionModel(sessionId, 'local/m2');
        assert.equal(app2.service.getSessionModel(sessionId), 'local/m2');
      } finally {
        await app2.dispose();
      }
      const again = await openPersistenceRuntime(root);
      try {
        assert.equal(
          again.projections.sessions.get(sessionId)?.model,
          'local/m2',
        );
      } finally {
        await again.dispose();
      }
    } catch (error) {
      try {
        await app.dispose();
      } catch {
        /* already disposed */
      }
      throw error;
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('COMPLETED 对外结果兑现前终态事件已提交', async () => {
  const root = await tempRoot();
  try {
    const app = await bootstrap(
      baseConfig(root),
      withClient(mockClient(['answer'])),
    );
    try {
      const { sessionId } = await app.service.createSession();
      const handle = app.service.submit(sessionId, 'q');
      const result = await handle.result;
      assert.equal(result.status, 'COMPLETED');
      // Immediate reopen of the same store after dispose must see completed.
      await app.dispose();
      const check = await openPersistenceRuntime(root);
      try {
        const execution = [...check.projections.executions.values()].find(
          (item) => item.sessionId === sessionId,
        );
        assert.equal(execution?.status, 'COMPLETED');
        const messages =
          check.projections.messagesBySession.get(sessionId) ?? [];
        assert.ok(messages.some((item) => item.role === 'assistant'));
      } finally {
        await check.dispose();
      }
    } catch (error) {
      try {
        await app.dispose();
      } catch {
        /* already disposed */
      }
      throw error;
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('PENDING_PERSIST 取消不会留下无终态幽灵 Execution', async () => {
  const root = await tempRoot();
  try {
    const app = await bootstrap(
      baseConfig(root),
      withClient(mockClient(['unused'])),
    );
    try {
      const { sessionId } = await app.service.createSession();
      for (let i = 0; i < 20; i++) {
        const handle = app.service.submit(sessionId, `pending-${i}`);
        assert.equal(app.service.cancel(sessionId, handle.executionId), true);
        assert.equal((await handle.result).status, 'CANCELLED');
      }
      await app.dispose();
      const check = await openPersistenceRuntime(root);
      try {
        for (const execution of check.projections.executions.values()) {
          if (execution.sessionId !== sessionId) continue;
          assert.notEqual(execution.status, 'CREATED');
          assert.notEqual(execution.status, 'STARTED');
          assert.ok(
            execution.status === 'CANCELLED' ||
              execution.status === 'INTERRUPTED',
          );
          if (execution.status === 'INTERRUPTED') {
            // Only acceptable if cancelled after create but cancel terminal missing —
            // that path must not happen with the new cancel coordination.
            assert.fail(
              `ghost execution ${execution.executionId} left as ${execution.status}`,
            );
          }
        }
      } finally {
        await check.dispose();
      }
    } catch (error) {
      try {
        await app.dispose();
      } catch {
        /* already disposed */
      }
      throw error;
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('并发创建 Session 与删除 Workspace 不得双双成功', async () => {
  const root = await tempRoot();
  try {
    const app = await bootstrap(
      baseConfig(root),
      withClient(mockClient(['ok'])),
    );
    try {
      let bothSucceeded = 0;
      for (let i = 0; i < 30; i++) {
        const wsRoot = await mkdtemp(path.join(tmpdir(), 'ea-p24-ws-'));
        const workspace = await app.service.registerWorkspace(
          `race-${i}`,
          wsRoot,
        );
        const create = app.service
          .createSession({ workspaceId: workspace.id })
          .then(() => 'created' as const)
          .catch(() => 'create_failed' as const);
        const remove = app.service
          .removeWorkspace(workspace.id)
          .then((ok) => (ok ? ('removed' as const) : ('remove_false' as const)))
          .catch(() => 'remove_failed' as const);
        const [c, r] = await Promise.all([create, remove]);
        if (c === 'created' && r === 'removed') bothSucceeded++;
      }
      assert.equal(bothSucceeded, 0);
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('Workspace 登记持久化失败时回滚内存可见性', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    const bridge = new PersistenceBridge(runtime);
    const poison = await runtime.coordinator.commitWorkspaceRecords(
      [
        {
          type: 'workspace/registered',
          payload: {
            workspaceId: 'poison',
            name: 'poison',
            rootPath: root,
          },
        },
      ],
      { failBeforeSyncIfLineIncludes: '"state":"COMMITTED"' },
    );
    assert.equal(poison.status, 'commit_uncertain');

    const { DefaultAgentApplicationService } =
      await import('../src/application/default-agent-application-service.ts');
    const { DefaultAgentManager } =
      await import('../src/agent/default-agent-manager.ts');
    const { DefaultExecutionEngine } =
      await import('../src/execution/engine/index.ts');
    const { DefaultAgentLoop } =
      await import('../src/execution/loops/index.ts');
    const { DefaultToolRegistry, GuardedToolExecutor } =
      await import('../src/runtime/tool/index.ts');
    const { WorkspaceManager, WorkspaceAccessCoordinator } =
      await import('../src/runtime/workspace/index.ts');
    const { DefaultModelRegistry } =
      await import('../src/runtime/model/index.ts');

    const coordinator = new WorkspaceAccessCoordinator();
    const workspaces = new WorkspaceManager({ coordinator });
    const registry = new DefaultToolRegistry();
    const executor = new GuardedToolExecutor(registry);
    const client = mockClient(['x']);
    const models = new DefaultModelRegistry(new Map([['local', client]]), [
      'local/m1',
    ]);
    const loop = new DefaultAgentLoop(client, registry, executor);
    const engine = new DefaultExecutionEngine({ logger });
    const manager = new DefaultAgentManager(engine, loop, {
      logger,
      persistence: bridge,
    });
    const service = new DefaultAgentApplicationService(manager, {
      modelCatalog: models,
      workspaces,
      coordinator,
      persistence: bridge,
      defaultSessionOptions: {
        config: { model: { name: 'local/m1' } },
      },
    });

    const before = service.listWorkspaces().length;
    const wsDir = await mkdtemp(path.join(tmpdir(), 'ea-p24-reg-'));
    await assert.rejects(() => service.registerWorkspace('ghost', wsDir));
    assert.equal(service.listWorkspaces().length, before);
    await runtime.dispose();
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('dataDir 与事件文件使用 owner-only 权限', async () => {
  if (process.platform === 'win32') return;
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    try {
      await runtime.commitSessionEvents('s-perm', [
        { type: 'session/created', payload: { model: 'm' } },
      ]);
      const rootMode = (await stat(root)).mode & 0o777;
      assert.equal(rootMode, PRIVATE_DIR_MODE);
      const eventsMode =
        (await stat(sessionEventsPath(resolveLayout(root), 's-perm'))).mode &
        0o777;
      assert.equal(eventsMode, PRIVATE_FILE_MODE);
    } finally {
      await runtime.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('删除 Session 后重启不复活', async () => {
  const root = await tempRoot();
  try {
    const app1 = await bootstrap(
      baseConfig(root),
      withClient(mockClient(['ok'])),
    );
    let sessionId: string;
    try {
      sessionId = (await app1.service.createSession()).sessionId;
      assert.equal(await app1.service.deleteSession(sessionId), true);
      assert.equal(
        app1.service
          .listSessions()
          .some((item) => item.sessionId === sessionId),
        false,
      );
    } finally {
      await app1.dispose();
    }
    const app2 = await bootstrap(
      baseConfig(root),
      withClient(mockClient(['ok'])),
    );
    try {
      assert.equal(
        app2.service
          .listSessions()
          .some((item) => item.sessionId === sessionId),
        false,
      );
    } finally {
      await app2.dispose();
    }
    const check = await openPersistenceRuntime(root);
    try {
      assert.equal(check.projections.sessions.get(sessionId)?.removed, true);
    } finally {
      await check.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('PENDING_PERSIST 期间不可当作空闲 Session 删除', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    const bridge = new PersistenceBridge(runtime);
    let releaseCreate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    let blockedCreate = false;
    const original = bridge.requireSessionEvents.bind(bridge);
    bridge.requireSessionEvents = async (sessionId, drafts) => {
      if (drafts.some((draft) => draft.type === 'execution/created')) {
        blockedCreate = true;
        await gate;
      }
      return original(sessionId, drafts);
    };

    const { service } = await buildPersistedService(bridge);
    try {
      const { sessionId } = await service.createSession();
      const handle = service.submit(sessionId, 'hold');
      for (let i = 0; i < 200 && !blockedCreate; i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(blockedCreate, true);
      assert.equal(await service.deleteSession(sessionId), false);
      releaseCreate();
      assert.equal((await handle.result).status, 'COMPLETED');
    } finally {
      await runtime.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('Workspace 登记已提交但 Projection 刷新失败时保留内存可见性', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    const bridge = new PersistenceBridge(runtime);
    const { service } = await buildPersistedService(bridge);
    try {
      const before = service.listWorkspaces().length;
      const wsDir = await mkdtemp(path.join(tmpdir(), 'ea-p24-reg-ok-'));
      bridge.failNextProjectionRefresh(1);
      const workspace = await service.registerWorkspace('kept', wsDir);
      assert.equal(service.listWorkspaces().length, before + 1);
      assert.ok(
        service.listWorkspaces().some((item) => item.id === workspace.id),
      );
      await runtime.dispose();
      const again = await openPersistenceRuntime(root);
      try {
        assert.equal(
          again.projections.workspaces.get(workspace.id)?.removed,
          false,
        );
      } finally {
        await again.dispose();
      }
    } catch (error) {
      await runtime.dispose().catch(() => undefined);
      throw error;
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('execution/created 已提交且刷新失败时取消仍写终态', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    const bridge = new PersistenceBridge(runtime);
    const { service } = await buildPersistedService(bridge);
    try {
      const { sessionId } = await service.createSession();
      bridge.failNextProjectionRefresh(1);
      const handleBox: {
        current?: ReturnType<typeof service.submit>;
      } = {};
      const original = bridge.requireSessionEvents.bind(bridge);
      bridge.requireSessionEvents = async (sessionIdArg, drafts) => {
        if (drafts.some((draft) => draft.type === 'execution/created')) {
          // Cancel after create commit starts but before durableCommitted error returns.
          const current = handleBox.current;
          assert.ok(current);
          service.cancel(sessionIdArg, current.executionId);
        }
        return original(sessionIdArg, drafts);
      };
      handleBox.current = service.submit(sessionId, 'cancel-after-create');
      assert.equal((await handleBox.current.result).status, 'CANCELLED');
      await runtime.dispose();
      const check = await openPersistenceRuntime(root);
      try {
        const execution = [...check.projections.executions.values()].find(
          (item) => item.sessionId === sessionId,
        );
        assert.ok(execution);
        assert.equal(execution.status, 'CANCELLED');
      } finally {
        await check.dispose();
      }
    } catch (error) {
      await runtime.dispose().catch(() => undefined);
      throw error;
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('session/created 恢复初始上下文与模型参数、extensions', async () => {
  const root = await tempRoot();
  try {
    const app1 = await bootstrap(
      baseConfig(root),
      withClient(mockClient(['unused'])),
    );
    let sessionId: string;
    try {
      sessionId = (
        await app1.service.createSession({
          context: {
            messages: [{ role: 'user', content: 'seed-context' }],
          },
          config: {
            model: {
              name: 'local/m1',
              parameters: { temperature: 0.25 },
            },
            tools: { allowedNames: [] },
            extensions: { defaultAgentLoop: { maxModelRetries: 1 } },
          },
        })
      ).sessionId;
    } finally {
      await app1.dispose();
    }

    const stored = await openPersistenceRuntime(root);
    try {
      const projection = stored.projections.sessions.get(sessionId);
      assert.ok(projection);
      assert.equal(
        (projection.initialContext?.messages?.[0] as { content?: string })
          ?.content,
        'seed-context',
      );
      assert.equal(projection.modelParameters?.temperature, 0.25);
      assert.deepEqual(projection.allowedNames, []);
      assert.equal(
        (
          projection.extensions?.defaultAgentLoop as {
            maxModelRetries?: number;
          }
        )?.maxModelRetries,
        1,
      );
    } finally {
      await stored.dispose();
    }

    let sawSeed = false;
    const app2 = await bootstrap(baseConfig(root), {
      logger,
      providerFactories: {
        'openai-compatible': () => ({ client: mockClient(['ok']) }),
      },
      loop: {
        async *run(context) {
          sawSeed = context.context.messages.some(
            (message) =>
              message.role === 'user' && message.content === 'seed-context',
          );
          yield { type: 'loop_start' };
          yield {
            type: 'loop_end',
            result: {
              status: 'completed',
              output: 'ok',
              updatedContext: {
                messages: [
                  ...context.context.messages,
                  { role: 'user', content: context.input.content },
                  { role: 'assistant', content: 'ok' },
                ],
              },
            },
          };
        },
      },
    });
    try {
      assert.equal(
        (await app2.service.submit(sessionId, 'next').result).status,
        'COMPLETED',
      );
      assert.equal(sawSeed, true);
      assert.equal(app2.service.getSessionModel(sessionId), 'local/m1');
    } finally {
      await app2.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('冷启动：Session 引用不存在的 Workspace 时 Bootstrap 失败', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    const outcome = await runtime.commitSessionEvents('s-orphan', [
      {
        type: 'session/created',
        payload: { model: 'local/m1', workspaceId: 'ghost-ws' },
      },
    ]);
    assert.equal(outcome.status, 'committed');
    await runtime.dispose();

    const { BootstrapError } = await import('../src/composition/bootstrap.ts');
    await assert.rejects(
      () => bootstrap(baseConfig(root), withClient(mockClient(['x']))),
      (error: unknown) =>
        (error instanceof PersistenceError && error.code === 'corrupt_store') ||
        (error instanceof BootstrapError &&
          error.code === 'initialization_failed'),
    );
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('并发提交后 Projection 刷新不丢 Session', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    try {
      for (let round = 0; round < 20; round++) {
        const left = `s-left-${round}`;
        const right = `s-right-${round}`;
        await Promise.all([
          runtime
            .commitSessionEvents(left, [
              { type: 'session/created', payload: { model: 'm' } },
            ])
            .then(async (outcome) => {
              assert.equal(outcome.status, 'committed');
              await runtime.refreshProjections();
            }),
          runtime
            .commitSessionEvents(right, [
              { type: 'session/created', payload: { model: 'm' } },
            ])
            .then(async (outcome) => {
              assert.equal(outcome.status, 'committed');
              await runtime.refreshProjections();
            }),
        ]);
        assert.ok(runtime.projections.sessions.has(left));
        assert.ok(runtime.projections.sessions.has(right));
      }
    } finally {
      await runtime.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('Application 可查询恢复后的历史 Execution', async () => {
  const root = await tempRoot();
  try {
    const app1 = await bootstrap(
      baseConfig(root),
      withClient(mockClient(['answer'])),
    );
    let sessionId: string;
    let executionId: string;
    try {
      sessionId = (await app1.service.createSession()).sessionId;
      const handle = app1.service.submit(sessionId, 'query-me');
      assert.equal((await handle.result).status, 'COMPLETED');
      executionId = handle.executionId;
      const listed = app1.service.listSessionExecutions(sessionId);
      assert.ok(listed.some((item) => item.executionId === executionId));
      assert.equal(
        app1.service.getExecution(sessionId, executionId)?.status,
        'COMPLETED',
      );
    } finally {
      await app1.dispose();
    }
    const app2 = await bootstrap(
      baseConfig(root),
      withClient(mockClient(['ok'])),
    );
    try {
      assert.ok(
        app2.service
          .listSessions()
          .some((item) => item.sessionId === sessionId),
      );
      const restored = app2.service.listSessionExecutions(sessionId);
      assert.ok(restored.some((item) => item.executionId === executionId));
      assert.equal(
        app2.service.getExecution(sessionId, executionId)?.input,
        'query-me',
      );
    } finally {
      await app2.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('Session ID 不得使 Event Log 写出 dataDir', async () => {
  const root = await tempRoot();
  const outside = await mkdtemp(path.join(tmpdir(), 'ea-p24-escape-'));
  try {
    const runtime = await openPersistenceRuntime(root);
    try {
      const escapeId = path.relative(path.join(root, 'sessions'), outside);
      assert.ok(escapeId.includes('..'));
      await assert.rejects(
        () =>
          runtime.commitSessionEvents(escapeId, [
            { type: 'session/created', payload: { model: 'm' } },
          ]),
        (error: unknown) =>
          error instanceof PersistenceError && error.code === 'invalid_request',
      );
      await assert.rejects(
        () =>
          runtime.commitSessionEvents('../../evil', [
            { type: 'session/created', payload: {} },
          ]),
        (error: unknown) =>
          error instanceof PersistenceError && error.code === 'invalid_request',
      );
    } finally {
      await runtime.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await rm(outside, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('updatedContext 完整替换后重启保留权威历史', async () => {
  const root = await tempRoot();
  try {
    const app1 = await bootstrap(baseConfig(root), {
      logger,
      providerFactories: {
        'openai-compatible': () => ({ client: mockClient(['unused']) }),
      },
      loop: {
        async *run(context) {
          yield { type: 'loop_start' };
          yield {
            type: 'loop_end',
            result: {
              status: 'completed',
              output: 'replaced',
              updatedContext: {
                messages: [{ role: 'user', content: 'replacement' }],
              },
            },
          };
          void context;
        },
      },
    });
    let sessionId: string;
    try {
      sessionId = (
        await app1.service.createSession({
          context: {
            messages: [{ role: 'user', content: 'seed' }],
          },
        })
      ).sessionId;
      assert.equal(
        (await app1.service.submit(sessionId, 'first').result).status,
        'COMPLETED',
      );
    } finally {
      await app1.dispose();
    }

    let saw: string[] = [];
    const app2 = await bootstrap(baseConfig(root), {
      logger,
      providerFactories: {
        'openai-compatible': () => ({ client: mockClient(['ok']) }),
      },
      loop: {
        async *run(context) {
          saw = context.context.messages.map((message) =>
            typeof message.content === 'string' ? message.content : '',
          );
          yield { type: 'loop_start' };
          yield {
            type: 'loop_end',
            result: {
              status: 'completed',
              output: 'ok',
              updatedContext: context.context,
            },
          };
        },
      },
    });
    try {
      assert.equal(
        (await app2.service.submit(sessionId, 'probe').result).status,
        'COMPLETED',
      );
      assert.deepEqual(saw, ['replacement']);
    } finally {
      await app2.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('COMMIT_UNCERTAIN 删除不得恢复为未删除', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    const bridge = new PersistenceBridge(runtime);
    const { service, manager } = await buildPersistedService(bridge);
    const { sessionId } = await service.createSession();
    bridge.failNextCommittedSync(1);
    await assert.rejects(() => service.deleteSession(sessionId));
    // Still closed / not revived as a fully live idle session.
    const session = manager.getSession(sessionId) as
      DefaultSessionAgent | undefined;
    assert.ok(session);
    assert.equal(session.closeIfIdle(), false);
    await runtime.dispose();

    const app = await bootstrap(
      baseConfig(root),
      withClient(mockClient(['ok'])),
    );
    try {
      assert.equal(
        app.service.listSessions().some((item) => item.sessionId === sessionId),
        false,
      );
    } finally {
      await app.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('COMMIT_UNCERTAIN 登记不得回滚内存可见性', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    const bridge = new PersistenceBridge(runtime);
    const { service } = await buildPersistedService(bridge);
    const before = service.listWorkspaces().length;
    const wsDir = await mkdtemp(path.join(tmpdir(), 'ea-p24-uncert-'));
    bridge.failNextCommittedSync(1);
    await assert.rejects(() => service.registerWorkspace('uncert', wsDir));
    assert.equal(service.listWorkspaces().length, before + 1);
    await runtime.dispose();
    const again = await openPersistenceRuntime(root);
    try {
      const registered = [...again.projections.workspaces.values()].find(
        (item) => item.name === 'uncert',
      );
      assert.ok(registered);
      assert.equal(registered.removed, false);
    } finally {
      await again.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('终态持久化期间不可空闲删除', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    const bridge = new PersistenceBridge(runtime);
    let releaseTerminal!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    let blockedTerminal = false;
    const original = bridge.requireSessionEvents.bind(bridge);
    bridge.requireSessionEvents = async (sessionId, drafts) => {
      if (drafts.some((draft) => draft.type === 'execution/completed')) {
        blockedTerminal = true;
        await gate;
      }
      return original(sessionId, drafts);
    };
    const { service, manager } = await buildPersistedService(bridge);
    const { sessionId } = await service.createSession();
    const handle = service.submit(sessionId, 'settle-hold');
    for (let i = 0; i < 200 && !blockedTerminal; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(blockedTerminal, true);
    const session = manager.getSession(sessionId) as
      DefaultSessionAgent | undefined;
    assert.ok(session);
    assert.equal(session.closeIfIdle(), false);
    assert.equal(await service.deleteSession(sessionId), false);
    releaseTerminal();
    assert.equal((await handle.result).status, 'COMPLETED');
    await runtime.dispose();
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function buildPersistedService(bridge: PersistenceBridge) {
  const { DefaultAgentApplicationService } =
    await import('../src/application/default-agent-application-service.ts');
  const { DefaultAgentManager } =
    await import('../src/agent/default-agent-manager.ts');
  const { DefaultExecutionEngine } =
    await import('../src/execution/engine/index.ts');
  const { DefaultAgentLoop } = await import('../src/execution/loops/index.ts');
  const { DefaultToolRegistry, GuardedToolExecutor } =
    await import('../src/runtime/tool/index.ts');
  const { WorkspaceManager, WorkspaceAccessCoordinator } =
    await import('../src/runtime/workspace/index.ts');
  const { DefaultModelRegistry } =
    await import('../src/runtime/model/index.ts');

  const coordinator = new WorkspaceAccessCoordinator();
  const workspaces = new WorkspaceManager({ coordinator });
  const registry = new DefaultToolRegistry();
  const executor = new GuardedToolExecutor(registry);
  const client = mockClient(['done']);
  const models = new DefaultModelRegistry(new Map([['local', client]]), [
    'local/m1',
  ]);
  const loop = new DefaultAgentLoop(client, registry, executor, {
    persistence: bridge,
  });
  const engine = new DefaultExecutionEngine({ logger });
  const manager = new DefaultAgentManager(engine, loop, {
    logger,
    persistence: bridge,
  });
  const service = new DefaultAgentApplicationService(manager, {
    modelCatalog: models,
    workspaces,
    coordinator,
    persistence: bridge,
    defaultSessionOptions: {
      config: { model: { name: 'local/m1' } },
    },
  });
  return { service, manager, coordinator, workspaces };
}

test('运行中 Terminal intent 拒绝人工恢复；结束后可覆盖', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    const bridge = new PersistenceBridge(runtime);
    const { service, coordinator, workspaces } =
      await buildPersistedService(bridge);
    const { AgentApplicationError } =
      await import('../src/application/agent-application-service.ts');

    const ws = await workspaces.register('live-ws', root);
    await bridge.requireWorkspaceRecords([
      {
        type: 'workspace/registered',
        payload: {
          workspaceId: ws.id,
          name: ws.name,
          rootPath: ws.rootPath,
        },
      },
      {
        type: 'workspace/terminal_intent',
        payload: { activityId: 'act-live', workspaceId: ws.id },
      },
    ]);
    await runtime.refreshProjections();
    assert.equal(
      runtime.projections.workspaces.get(ws.id)?.openIntents.has('act-live'),
      true,
    );

    coordinator.beginTerminalActivity(ws.id, 'act-live');
    await assert.rejects(
      () => service.recoverWorkspace(ws.id),
      (error: unknown) =>
        error instanceof AgentApplicationError &&
        error.code === 'operation_failed',
    );
    assert.equal(
      runtime.projections.workspaces.get(ws.id)?.openIntents.has('act-live'),
      true,
    );

    coordinator.endTerminalActivity(ws.id, 'act-live');
    await service.recoverWorkspace(ws.id);
    await runtime.refreshProjections();
    assert.equal(runtime.projections.workspaces.get(ws.id)?.safety, 'NORMAL');
    assert.equal(
      runtime.projections.workspaces.get(ws.id)?.openIntents.size,
      0,
    );
    await runtime.dispose();
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('审批拒绝的 approval/resolved 持久化失败须 fail-closed', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    const bridge = new PersistenceBridge(runtime);
    const { DefaultToolRegistry, GuardedToolExecutor } =
      await import('../src/runtime/tool/index.ts');
    const { ApprovalService } =
      await import('../src/runtime/approval/index.ts');

    const registry = new DefaultToolRegistry();
    registry.register(
      {
        name: 'echo',
        description: 'echo',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
      },
      (args) => ({ content: String(args.text) }),
      { approval: 'always', workspaceAccess: 'none' },
    );
    const approval = new ApprovalService();
    const executor = new GuardedToolExecutor(registry, {
      approval,
      persistence: bridge,
      approvalTimeoutMs: 5_000,
    });
    await bridge.requireSessionEvents('s-approval', [
      { type: 'session/created', payload: { model: 'm' } },
    ]);

    const pending: string[] = [];
    approval.subscribe((request) => {
      if (request.status === 'PENDING') pending.push(request.id);
    });
    const rejected = executor.execute(
      {
        id: 'call-1',
        name: 'echo',
        argumentsJson: '{"text":"no"}',
      },
      {
        sessionId: 's-approval',
        executionId: 'e-approval',
      },
    );
    for (let i = 0; i < 50 && pending.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(pending.length, 1);
    bridge.failNextCommittedSync(1);
    approval.decide(pending[0]!, 'reject');
    await assert.rejects(
      () => rejected,
      (error: unknown) =>
        error instanceof PersistenceError && error.code === 'commit_uncertain',
    );
    await runtime.dispose();
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
