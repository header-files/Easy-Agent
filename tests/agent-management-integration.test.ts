import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLogger,
  DefaultAgentManager,
  DefaultExecutionEngine,
  type AgentLoop,
  type AgentLoopContext,
  type AgentLoopResult,
  type ExecutionEvent,
  type SessionSubmitOptions,
} from '../src/index.ts';

const logger = createLogger({ destination: { write() {} } });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function manager(loop: AgentLoop) {
  return new DefaultAgentManager(
    new DefaultExecutionEngine({ logger, maxRetainedSnapshots: 0 }),
    loop,
    { logger },
  );
}
async function collect(source: AsyncIterable<ExecutionEvent>) {
  const events: ExecutionEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

test(
  '同Session无人观察时仍严格FIFO，实际启动读取最新成功历史且当前输入不重复',
  { timeout: 3000 },
  async () => {
    const entered = deferred();
    const release = deferred();
    const seen: AgentLoopContext[] = [];
    const loop: AgentLoop = {
      async *run(context) {
        seen.push(context);
        yield { type: 'loop_start' };
        if (context.input.content === 'A') {
          entered.resolve();
          await release.promise;
        }
        yield {
          type: 'loop_end',
          result: {
            status: 'completed',
            output: context.input.content,
            updatedContext: {
              messages: [
                ...context.context.messages,
                { role: 'user', content: context.input.content },
                {
                  role: 'assistant',
                  content: `answer:${context.input.content}`,
                },
              ],
            },
          },
        };
      },
    };
    const instance = manager(loop);
    const session = instance.createSession();
    const submissions = ['A', 'B', 'C'].map((input) => session.submit(input));
    assert.equal(seen.length, 0);
    assert.equal(instance.listSessions()[0]?.queuedCount, 3);
    try {
      await entered.promise;
      assert.deepEqual(
        seen.map((item) => item.input.content),
        ['A'],
      );
      assert.equal(
        instance.listSessions()[0]?.runningExecutionId,
        submissions[0]?.executionId,
      );
      assert.equal(instance.listSessions()[0]?.queuedCount, 2);
      assert.equal(await instance.deleteSession(session.sessionId), false);
      assert.deepEqual(session.getContext().messages, []);
      release.resolve();
      const results = await Promise.all(submissions.map((item) => item.result));
      assert.ok(results.every((result) => result.status === 'COMPLETED'));
      assert.deepEqual(
        seen.map((item) => item.input.content),
        ['A', 'B', 'C'],
      );
      assert.deepEqual(
        seen.map((item) => item.context.messages.length),
        [0, 2, 4],
      );
      assert.deepEqual(
        seen[2]?.context.messages.map((message) => message.content),
        ['A', 'answer:A', 'B', 'answer:B'],
      );
      assert.deepEqual(
        seen.map((item) => item.metadata?.executionId),
        submissions.map((item) => item.executionId),
      );
      assert.ok(
        seen.every((item) => item.metadata?.sessionId === session.sessionId),
      );
      assert.equal(
        new Set(submissions.map((item) => item.executionId)).size,
        3,
      );
      assert.equal(session.getContext().messages.length, 6);
      const late = await collect(submissions[1]!.events);
      assert.equal(late[0]?.type, 'execution_start');
      const last = late.at(-1);
      if (last?.type !== 'execution_end') throw new Error();
      assert.deepEqual(last.result, results[1]);
    } finally {
      release.resolve();
      await Promise.all(submissions.map((item) => item.result));
    }
  },
);

test('仅成功updatedContext全量替换，缺省、失败和stopped不污染后续上下文', async () => {
  const observed = new Map<string, AgentLoopContext['context']>();
  const loop: AgentLoop = {
    async *run(context) {
      const input = context.input.content;
      observed.set(input, context.context);
      yield { type: 'loop_start' };
      if (input === 'failed') throw new Error('private dependency failure');
      if (input === 'without') {
        yield {
          type: 'loop_end',
          result: { status: 'completed', output: 'without' },
        };
        return;
      }
      const updatedContext = {
        messages: [{ role: 'system' as const, content: input }],
      };
      const result: AgentLoopResult =
        input === 'stopped'
          ? {
              status: 'stopped',
              reason: 'custom_policy',
              output: input,
              updatedContext,
            }
          : { status: 'completed', output: input, updatedContext };
      yield { type: 'loop_end', result };
    },
  };
  const session = manager(loop).createSession({
    context: {
      messages: [{ role: 'user', content: 'initial' }],
      data: { old: true },
    },
  });
  const inputs = ['success', 'without', 'stopped', 'failed', 'last'];
  const results = await Promise.all(
    inputs.map((input) => session.submit(input).result),
  );
  assert.deepEqual(
    results.map((result) => result.status),
    ['COMPLETED', 'COMPLETED', 'FAILED', 'FAILED', 'COMPLETED'],
  );
  for (const input of inputs.slice(1))
    assert.deepEqual(
      observed.get(input),
      { messages: [{ role: 'system', content: 'success' }] },
      input,
    );
  assert.deepEqual(session.getContext(), {
    messages: [{ role: 'system', content: 'last' }],
  });
});

test(
  '配置按参数键和extensions命名空间合并，提交配置在入队时复制且不改变默认值',
  { timeout: 3000 },
  async () => {
    const entered = deferred();
    const release = deferred();
    const seen: AgentLoopContext['config'][] = [];
    const loop: AgentLoop = {
      async *run(context) {
        seen.push(context.config);
        yield { type: 'loop_start' };
        if (context.input.content === 'A') {
          entered.resolve();
          await release.promise;
        }
        yield {
          type: 'loop_end',
          result: { status: 'completed', output: 'ok' },
        };
      },
    };
    const defaults = {
      model: {
        name: 'model-a',
        parameters: {
          temperature: 0.3,
          maxOutputTokens: 2048,
          vendor: { original: true },
        },
      },
      tools: { allowedNames: ['echo'] },
      extensions: {
        defaultAgentLoop: { maxModelRetries: 2, modelTimeoutMs: 30000 },
        keep: { nested: true },
      },
    };
    const session = manager(loop).createSession({ config: defaults });
    defaults.model.name = 'caller mutation';
    defaults.model.parameters.temperature = 1.9;
    const override: SessionSubmitOptions = {
      config: {
        model: {
          parameters: { temperature: 0.7, vendor: { replacement: true } },
        },
        tools: { allowedNames: [] },
        extensions: { defaultAgentLoop: { maxModelRetries: 0 } },
      },
    };
    const a = session.submit('A');
    const b = session.submit('B', override);
    const c = session.submit('C');
    override.config!.model!.parameters!.temperature = 1.8;
    override.config!.tools!.allowedNames = ['mutated'];
    override.config!.extensions = { replacedAfterSubmit: true };
    try {
      await entered.promise;
      release.resolve();
      await Promise.all([a.result, b.result, c.result]);
      const original = {
        model: {
          name: 'model-a',
          parameters: {
            temperature: 0.3,
            maxOutputTokens: 2048,
            vendor: { original: true },
          },
        },
        tools: { allowedNames: ['echo'] },
        extensions: {
          defaultAgentLoop: { maxModelRetries: 2, modelTimeoutMs: 30000 },
          keep: { nested: true },
        },
      };
      assert.deepEqual(seen[0], original);
      assert.deepEqual(seen[1], {
        model: {
          name: 'model-a',
          parameters: {
            temperature: 0.7,
            maxOutputTokens: 2048,
            vendor: { replacement: true },
          },
        },
        tools: { allowedNames: [] },
        extensions: {
          defaultAgentLoop: { maxModelRetries: 0 },
          keep: { nested: true },
        },
      });
      assert.deepEqual(seen[2], original);
      const custom = manager(loop).createSession();
      assert.throws(
        () =>
          custom.submit('invalid', {
            config: { model: { parameters: { temperature: 0.5 } } },
          }),
        /configuration/,
      );
      assert.equal(
        (await custom.submit('', { config: { model: {} } }).result).status,
        'COMPLETED',
      );
    } finally {
      release.resolve();
      await Promise.all([a.result, b.result, c.result]);
    }
  },
);

test('创建输入、Loop工作副本、observer事件、result和getContext不能改写Session已提交数据', async () => {
  const callback = () => 42;
  const initial = {
    messages: [{ role: 'user' as const, content: 'initial' }],
    data: { nested: { value: 1 }, callback },
  };
  const updated = {
    messages: [{ role: 'assistant' as const, content: 'committed' }],
    data: { nested: { value: 2 }, callback },
  };
  const loop: AgentLoop = {
    async *run(context) {
      yield { type: 'loop_start' };
      if (context.input.content === 'work-copy') {
        assert.equal(
          (context.context.data!.nested as { value: number }).value,
          1,
        );
        context.context.messages[0]!.content = 'Loop mutation';
        (context.context.data!.nested as { value: number }).value = 77;
        yield {
          type: 'loop_end',
          result: { status: 'completed', output: 'no update' },
        };
      } else
        yield {
          type: 'loop_end',
          result: {
            status: 'completed',
            output: 'ok',
            updatedContext: updated,
          },
        };
    },
  };
  const session = manager(loop).createSession({ context: initial });
  initial.messages[0]!.content = 'caller mutation';
  initial.data.nested.value = 99;
  await session.submit('work-copy').result;
  assert.deepEqual(session.getContext().messages, [
    { role: 'user', content: 'initial' },
  ]);
  assert.equal(
    (session.getContext().data!.nested as { value: number }).value,
    1,
  );
  const submission = session.submit('commit');
  const reader = (async () => {
    for await (const event of submission.events) {
      if (event.type === 'execution_end' && event.result.status === 'COMPLETED')
        (
          event.result.loopResult.updatedContext!.data!.nested as {
            value: number;
          }
        ).value = 88;
    }
  })();
  const [result] = await Promise.all([submission.result, reader]);
  assert.equal(result.status, 'COMPLETED');
  if (result.status !== 'COMPLETED') throw new Error();
  (result.loopResult.updatedContext!.data!.nested as { value: number }).value =
    66;
  updated.data.nested.value = 55;
  const queried = session.getContext();
  (queried.data!.nested as { value: number }).value = 44;
  queried.messages[0]!.content = 'query mutation';
  assert.deepEqual(session.getContext().messages, [
    { role: 'assistant', content: 'committed' },
  ]);
  assert.equal(
    (session.getContext().data!.nested as { value: number }).value,
    2,
  );
  assert.equal(session.getContext().data!.callback, callback);
});

test(
  '同tick高频submit只启动一个pump，复用带私有状态的CustomLoop且不依赖观察者',
  { timeout: 5000 },
  async () => {
    class LocalLoop implements AgentLoop {
      #active = 0;
      maxActive = 0;
      inputs: string[] = [];
      async *run(context: AgentLoopContext) {
        this.#active++;
        this.maxActive = Math.max(this.maxActive, this.#active);
        this.inputs.push(context.input.content);
        try {
          yield { type: 'loop_start' as const };
          await Promise.resolve();
          yield {
            type: 'loop_end' as const,
            result: {
              status: 'completed' as const,
              output: context.input.content,
            },
          };
        } finally {
          this.#active--;
        }
      }
    }
    const loop = new LocalLoop();
    const instance = manager(loop);
    const session = instance.createSession();
    const inputs = Array.from({ length: 100 }, (_, index) => `input-${index}`);
    const submissions = inputs.map((input) => session.submit(input));
    assert.equal(instance.listSessions()[0]?.queuedCount, 100);
    const results = await Promise.all(
      submissions.map((submission) => submission.result),
    );
    assert.deepEqual(loop.inputs, inputs);
    assert.equal(loop.maxActive, 1);
    assert.ok(results.every((result) => result.status === 'COMPLETED'));
    assert.equal(
      new Set(submissions.map((submission) => submission.executionId)).size,
      100,
    );
    assert.deepEqual(session.getContext(), { messages: [] });
    assert.equal(instance.listSessions()[0]?.queuedCount, 0);
    assert.equal(instance.listSessions()[0]?.runningExecutionId, undefined);
  },
);
