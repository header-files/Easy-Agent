import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AgentLoop,
  AgentLoopContext,
  AgentLoopEvent,
} from '../src/harness/contracts/agent-loop/index.ts';
import type {
  ExecutionEvent,
  ExecutionRequest,
} from '../src/harness/contracts/execution/index.ts';
import type { Logger } from '../src/runtime/logging/index.ts';
import { DefaultExecutionEngine } from '../src/execution/engine/index.ts';

const quiet: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return quiet;
  },
};
function context(): AgentLoopContext {
  return {
    input: { content: 'input' },
    context: { messages: [] },
    config: {},
    control: { signal: new AbortController().signal },
  };
}
function request(
  loop: AgentLoop,
  executionId = 'execution-1',
): ExecutionRequest {
  return { executionId, loop, context: context() };
}
async function collect(
  events: AsyncIterable<ExecutionEvent>,
): Promise<ExecutionEvent[]> {
  const result: ExecutionEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}
const completed: AgentLoop = {
  async *run() {
    yield { type: 'loop_start' };
    yield { type: 'output_delta', content: 'hello' };
    yield {
      type: 'loop_end',
      result: { status: 'completed', output: 'hello' },
    };
  },
};
const engine = () => new DefaultExecutionEngine({ logger: quiet });

test('Engine惰性启动、单次遍历并包装任意CustomLoop，终态与快照一致', async () => {
  const instance = engine();
  let calls = 0;
  const loop: AgentLoop = {
    async *run() {
      calls++;
      yield* completed.run(context());
    },
  };
  const events = instance.execute(request(loop));
  assert.equal(calls, 0);
  assert.equal(instance.getSnapshot('execution-1'), undefined);
  const observed = await collect(events);
  assert.equal(calls, 1);
  assert.deepEqual(
    observed.map((event) => event.type),
    [
      'execution_start',
      'loop_event',
      'loop_event',
      'loop_event',
      'execution_end',
    ],
  );
  const last = observed.at(-1);
  assert.equal(last?.type, 'execution_end');
  if (last?.type !== 'execution_end') throw new Error();
  assert.equal(last.result.status, 'COMPLETED');
  assert.deepEqual(instance.getSnapshot('execution-1')?.result, last.result);
  assert.throws(() => events[Symbol.asyncIterator](), /only be consumed once/);
  assert.equal(instance.cancel('execution-1'), false);
});

test('无效请求、元数据冲突和保留ID重复均为启动前错误，不创建新快照', async () => {
  const instance = engine();
  for (const id of ['', ' ', null])
    await assert.rejects(
      collect(instance.execute(request(completed, id as string))),
      /Invalid execution request/,
    );
  const invalid = request(completed);
  invalid.context.metadata = { executionId: 'different' };
  await assert.rejects(
    collect(instance.execute(invalid)),
    /Invalid execution request/,
  );
  assert.equal(instance.getSnapshot('execution-1'), undefined);
  await collect(instance.execute(request(completed)));
  await assert.rejects(
    collect(instance.execute(request(completed))),
    /already registered/,
  );
  assert.equal(instance.getSnapshot('execution-1')?.status, 'COMPLETED');
});

test('Loop received独立Context和Engine取消信号，metadata补齐不改调用方', async () => {
  const instance = engine();
  const source = request({
    async *run(value) {
      assert.equal(value.metadata?.executionId, 'execution-1');
      assert.equal(value.metadata?.sessionId, 'session');
      assert.notEqual(value.control.signal, source.context.control.signal);
      value.input.content = 'changed';
      value.config.model!.name = 'changed';
      value.context.messages[0]!.content = 'changed';
      yield { type: 'loop_start' };
      yield { type: 'loop_end', result: { status: 'completed', output: 'ok' } };
    },
  });
  source.context.config.model = { name: 'original' };
  source.context.context.messages = [{ role: 'user', content: 'original' }];
  source.context.metadata = { sessionId: 'session' };
  await collect(instance.execute(source));
  assert.equal(source.context.input.content, 'input');
  assert.equal(source.context.config.model.name, 'original');
  assert.equal(source.context.context.messages[0]?.content, 'original');
  assert.equal(source.context.metadata.executionId, undefined);
});

test('Loop stopped正常终止映射FAILED并保留完整LoopResult', async () => {
  const instance = engine();
  const observed = await collect(
    instance.execute(
      request({
        async *run() {
          yield { type: 'loop_start' };
          yield {
            type: 'loop_end',
            result: { status: 'stopped', reason: 'length', output: 'partial' },
          };
        },
      }),
    ),
  );
  const last = observed.at(-1);
  assert.equal(last?.type, 'execution_end');
  if (last?.type !== 'execution_end') throw new Error();
  assert.equal(last.result.status, 'FAILED');
  if (last.result.status === 'FAILED') {
    assert.equal(last.result.error.code, 'loop_stopped');
    assert.equal(last.result.loopResult?.status, 'stopped');
  }
});

test('Loop在start前或end后抛任意异常一律安全FAILED，不丢execution_end', async () => {
  for (const afterEnd of [false, true]) {
    const instance = engine();
    const observed = await collect(
      instance.execute(
        request({
          async *run() {
            if (afterEnd) {
              yield { type: 'loop_start' };
              yield {
                type: 'loop_end',
                result: { status: 'completed', output: 'not committed' },
              };
            }
            throw { secret: 'raw-secret-error' };
          },
        }),
      ),
    );
    const last = observed.at(-1);
    assert.equal(last?.type, 'execution_end');
    if (last?.type !== 'execution_end') throw new Error();
    assert.equal(last.result.status, 'FAILED');
    if (last.result.status === 'FAILED')
      assert.equal(last.result.error.code, 'loop_error');
    assert.equal(JSON.stringify(last).includes('raw-secret-error'), false);
  }
});

test('Loop缺少/重复生命周期事件或无效结果均映射loop_protocol_error', async () => {
  const start: AgentLoopEvent = { type: 'loop_start' };
  const end: AgentLoopEvent = {
    type: 'loop_end',
    result: { status: 'completed', output: 'ok' },
  };
  const sequences: unknown[][] = [
    [end],
    [start],
    [start, start, end],
    [start, end, end],
    [start, end, { type: 'output_delta', content: 'late' }],
    [start, { type: 'loop_end', result: { status: 'completed' } }],
    [start, { type: 'loop_end', result: { status: 'other', output: 'x' } }],
  ];
  for (const sequence of sequences) {
    const instance = engine();
    const observed = await collect(
      instance.execute(
        request({
          async *run() {
            yield* sequence as AgentLoopEvent[];
          },
        }),
      ),
    );
    const last = observed.at(-1);
    assert.equal(last?.type, 'execution_end');
    if (last?.type !== 'execution_end') throw new Error();
    assert.equal(last.result.status, 'FAILED');
    if (last.result.status === 'FAILED')
      assert.equal(last.result.error.code, 'loop_protocol_error');
    assert.equal(
      observed.filter((event) => event.type === 'execution_end').length,
      1,
    );
  }
});

test('loop_end不立即完成，必须真正确认迭代done', async () => {
  const instance = engine();
  let finish!: () => void;
  const barrier = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const iterable = instance.execute(
    request({
      async *run() {
        yield { type: 'loop_start' };
        yield {
          type: 'loop_end',
          result: { status: 'completed', output: 'ok' },
        };
        await barrier;
      },
    }),
  );
  const iterator = iterable[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.next();
  await iterator.next();
  assert.equal(instance.getSnapshot('execution-1')?.status, 'RUNNING');
  const pending = iterator.next();
  await Promise.resolve();
  assert.equal(instance.getSnapshot('execution-1')?.status, 'RUNNING');
  finish();
  assert.equal((await pending).value?.type, 'execution_end');
  assert.equal(instance.getSnapshot('execution-1')?.status, 'COMPLETED');
  await iterator.return?.();
});

test('有界保留只按终态完成顺序FIFO淘汰，零保留可用', async () => {
  const instance = new DefaultExecutionEngine({
    logger: quiet,
    maxRetainedSnapshots: 2,
  });
  for (const id of ['one', 'two', 'three'])
    await collect(instance.execute(request(completed, id)));
  assert.equal(instance.getSnapshot('one'), undefined);
  assert.equal(instance.getSnapshot('two')?.status, 'COMPLETED');
  assert.equal(instance.getSnapshot('three')?.status, 'COMPLETED');
  const none = new DefaultExecutionEngine({
    logger: quiet,
    maxRetainedSnapshots: 0,
  });
  await collect(none.execute(request(completed)));
  assert.equal(none.getSnapshot('execution-1'), undefined);
});
