import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentLoop } from '../src/harness/contracts/agent-loop/index.ts';
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
const loop: AgentLoop = {
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
            { role: 'assistant', content: 'answer' },
          ],
        },
      },
    };
  },
};
const manager = () =>
  new DefaultAgentManager(new DefaultExecutionEngine({ logger: quiet }), loop, {
    logger: quiet,
  });

test('Manager同步创建、稳定获取及按创建顺序返回独立Session摘要', () => {
  const instance = manager();
  const first = instance.createSession();
  const second = instance.createSession();
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(instance.getSession(first.sessionId), first);
  assert.equal(instance.getSession('absent'), undefined);
  const summaries = instance.listSessions();
  assert.deepEqual(
    summaries.map((value) => value.sessionId),
    [first.sessionId, second.sessionId],
  );
  assert.equal(summaries[0]?.queuedCount, 0);
  assert.equal(summaries[0]?.runningExecutionId, undefined);
  assert.match(summaries[0]!.createdAt, /^\d{4}-\d\d-\d\dT/);
  summaries[0]!.queuedCount = 999;
  summaries.length = 0;
  assert.equal(instance.listSessions()[0]?.queuedCount, 0);
});

test('Session默认空历史且Context快照独立，未消费事件也可完成一次CustomLoop提交', async () => {
  const instance = manager();
  const session = instance.createSession();
  assert.deepEqual(session.getContext(), { messages: [] });
  const handle = session.submit('hello');
  assert.equal(typeof handle.executionId, 'string');
  const result = await handle.result;
  assert.equal(result.status, 'COMPLETED');
  assert.equal(session.getContext().messages.length, 2);
  const context = session.getContext();
  context.messages[0]!.content = 'external change';
  assert.equal(session.getContext().messages[0]?.content, 'hello');
});

test('排队/运行任务阻止删除，空闲删除关闭旧Session引用但保留已结算结果', async () => {
  const instance = manager();
  const session = instance.createSession();
  const handle = session.submit('work');
  assert.equal(await instance.deleteSession(session.sessionId), false);
  await handle.result;
  assert.equal(await instance.deleteSession(session.sessionId), true);
  assert.equal(instance.getSession(session.sessionId), undefined);
  assert.deepEqual(instance.listSessions(), []);
  assert.throws(() => session.submit('later'), /closed/);
  assert.equal((await handle.result).status, 'COMPLETED');
  assert.equal(await instance.deleteSession(session.sessionId), false);
});

test('Session可固定自定义Loop且无需model配置，factory重复ID同步拒绝', async () => {
  const instance = manager();
  const session = instance.createSession({
    loop: {
      async *run() {
        yield { type: 'loop_start' };
        yield {
          type: 'loop_end',
          result: { status: 'completed', output: 'custom' },
        };
      },
    },
  });
  const result = await session.submit('input').result;
  assert.equal(result.status, 'COMPLETED');
  if (result.status === 'COMPLETED')
    assert.equal(result.loopResult.output, 'custom');
  const deterministic = new DefaultAgentManager(
    new DefaultExecutionEngine({ logger: quiet }),
    loop,
    {
      logger: quiet,
      sessionIdFactory: () => 'same-session',
      executionIdFactory: () => 'same-execution',
    },
  );
  const stable = deterministic.createSession();
  await stable.submit('first').result;
  assert.throws(() => stable.submit('duplicate'), /duplicate/);
  assert.equal(await deterministic.deleteSession(stable.sessionId), true);
  assert.throws(() => deterministic.createSession(), /duplicate/);
});
