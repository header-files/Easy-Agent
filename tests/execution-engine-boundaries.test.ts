import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLogger,
  DefaultExecutionEngine,
  ModelError,
  ToolExecutionError,
  type AgentLoop,
  type AgentLoopContext,
  type AgentLoopEvent,
  type AgentLoopResult,
  type ExecutionEvent,
} from '../src/index.ts';

const logger = createLogger({ destination: { write() {} } });
function context(): AgentLoopContext {
  return {
    input: { content: 'local input' },
    context: { messages: [] },
    config: {},
    control: { signal: new AbortController().signal },
  };
}
async function collect(source: AsyncIterable<ExecutionEvent>) {
  const events: ExecutionEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}
function end(events: ExecutionEvent[]) {
  assert.equal(events[0]?.type, 'execution_start');
  assert.equal(
    events.filter((event) => event.type === 'execution_start').length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === 'execution_end').length,
    1,
  );
  const last = events.at(-1);
  assert.equal(last?.type, 'execution_end');
  if (last?.type !== 'execution_end') throw new Error('Missing final result');
  return last.result;
}

test('任意CustomLoop事件原样包装，不要求默认模型工具算法或JSON自定义数据', async () => {
  const data: { self?: unknown; callback: () => number } = {
    callback: () => 42,
  };
  data.self = data;
  const expected: AgentLoopEvent[] = [
    { type: 'loop_start' },
    { type: 'custom_event', name: '', data: undefined },
    { type: 'custom_event', name: 'local.payload', data },
    {
      type: 'model_event',
      modelCallIndex: 1,
      event: { type: 'tool_call_delta', index: 0, argumentsDelta: '{' },
    },
    {
      type: 'tool_start',
      modelCallIndex: 1,
      call: { id: 'call', name: 'echo', argumentsJson: '{not-json' },
    },
    {
      type: 'tool_result',
      modelCallIndex: 1,
      result: {
        toolCallId: 'call',
        name: 'echo',
        status: 'error',
        content: 'custom failure',
        error: { code: 'execution_failed', message: 'custom failure' },
      },
    },
    { type: 'output_delta', content: '' },
    {
      type: 'loop_end',
      result: {
        status: 'stopped',
        reason: 'local_policy',
        details: { external: data },
      },
    },
  ];
  const loop: AgentLoop = {
    async *run() {
      yield* expected;
    },
  };
  const engine = new DefaultExecutionEngine({ logger });
  const events = await collect(
    engine.execute({ executionId: 'custom', loop, context: context() }),
  );
  assert.deepEqual(
    events
      .filter((event) => event.type === 'loop_event')
      .map((event) => event.event),
    expected,
  );
  const result = end(events);
  assert.equal(result.status, 'FAILED');
  if (result.status !== 'FAILED') throw new Error();
  assert.equal(result.error.code, 'loop_stopped');
  assert.deepEqual(
    result.loopResult,
    (expected.at(-1) as Extract<AgentLoopEvent, { type: 'loop_end' }>).result,
  );
  assert.deepEqual(engine.getSnapshot('custom')?.result, result);
});

test('第三方Loop结束结果的嵌套消息和字段必须符合既有契约，不能仅验证messages是数组', async () => {
  const invalidResults: [string, unknown][] = [
    ['unknown status', { status: 'other', output: 'x' }],
    ['missing completed output', { status: 'completed' }],
    [
      'invalid stopped output',
      { status: 'stopped', reason: 'policy', output: 1 },
    ],
    ['missing stopped reason', { status: 'stopped' }],
    ['array details', { status: 'completed', output: 'x', details: [] }],
    [
      'null context',
      { status: 'completed', output: 'x', updatedContext: null },
    ],
    [
      'missing messages',
      { status: 'completed', output: 'x', updatedContext: {} },
    ],
    [
      'primitive message',
      { status: 'completed', output: 'x', updatedContext: { messages: [42] } },
    ],
    [
      'unknown role',
      {
        status: 'completed',
        output: 'x',
        updatedContext: { messages: [{ role: 'unknown', content: 'x' }] },
      },
    ],
    [
      'invalid user content',
      {
        status: 'completed',
        output: 'x',
        updatedContext: { messages: [{ role: 'user', content: null }] },
      },
    ],
    [
      'invalid assistant calls',
      {
        status: 'completed',
        output: 'x',
        updatedContext: {
          messages: [
            {
              role: 'assistant',
              content: null,
              toolCalls: [{ id: 'call', name: 'echo', argumentsJson: 42 }],
            },
          ],
        },
      },
    ],
    [
      'invalid tool reference',
      {
        status: 'completed',
        output: 'x',
        updatedContext: {
          messages: [{ role: 'tool', toolCallId: 42, content: 'x' }],
        },
      },
    ],
    [
      'array context data',
      {
        status: 'completed',
        output: 'x',
        updatedContext: { messages: [], data: [] },
      },
    ],
  ];
  for (const [label, value] of invalidResults) {
    const engine = new DefaultExecutionEngine({ logger });
    const loop: AgentLoop = {
      async *run() {
        yield { type: 'loop_start' };
        yield { type: 'loop_end', result: value as AgentLoopResult };
      },
    };
    const events = await collect(
      engine.execute({ executionId: label, loop, context: context() }),
    );
    const result = end(events);
    assert.equal(result.status, 'FAILED', label);
    if (result.status !== 'FAILED') throw new Error(label);
    assert.equal(result.error.code, 'loop_protocol_error', label);
    assert.equal(
      events.some(
        (event) =>
          event.type === 'loop_event' && event.event.type === 'loop_end',
      ),
      false,
      label,
    );
    assert.deepEqual(engine.getSnapshot(label)?.result, result, label);
  }
});

test('Loop自身timeout或AbortError未接受Execution取消时均为FAILED，不泄露原始异常', async () => {
  const secret = 'private-error-detail';
  const errors = [
    new ModelError({ code: 'timeout', message: secret, retryable: true }),
    new ModelError({ code: 'aborted', message: secret, retryable: false }),
    new ToolExecutionError('timeout', secret),
    new ToolExecutionError('aborted', secret),
    new DOMException(secret, 'AbortError'),
    secret,
    {
      toString() {
        throw new Error(secret);
      },
    },
  ];
  for (const error of errors) {
    const engine = new DefaultExecutionEngine({ logger });
    const loop: AgentLoop = {
      run() {
        throw error;
      },
    };
    const source = context();
    const events = await collect(
      engine.execute({ executionId: 'error-case', loop, context: source }),
    );
    const result = end(events);
    assert.equal(result.status, 'FAILED');
    if (result.status !== 'FAILED') throw new Error();
    assert.equal(result.error.code, 'loop_error');
    assert.equal(JSON.stringify(events).includes(secret), false);
    assert.equal(source.control.signal.aborted, false);
    assert.equal(engine.cancel('error-case'), false);
  }
});

test('次要清理异常不覆盖Loop原错误或协议错误，日志故障不改变最终状态', async () => {
  for (const protocolFailure of [false, true]) {
    let closed = 0;
    let step = 0;
    const secret = 'private-cleanup-secret';
    const loop: AgentLoop = {
      run() {
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                step++;
                if (step === 1)
                  return {
                    done: false as const,
                    value: { type: 'loop_start' as const },
                  };
                if (protocolFailure)
                  return {
                    done: false as const,
                    value: { type: 'loop_start' as const },
                  };
                throw new Error(secret);
              },
              return() {
                closed++;
                throw new Error(secret);
              },
            };
          },
        };
      },
    };
    const badLogger = {
      debug() {},
      info() {},
      error() {},
      warn() {
        return Promise.reject(new Error(secret));
      },
      child() {
        return this;
      },
    };
    const engine = new DefaultExecutionEngine({ logger: badLogger });
    const result = end(
      await collect(
        engine.execute({ executionId: 'cleanup', loop, context: context() }),
      ),
    );
    assert.equal(result.status, 'FAILED');
    if (result.status !== 'FAILED') throw new Error();
    assert.equal(
      result.error.code,
      protocolFailure ? 'loop_protocol_error' : 'loop_error',
    );
    assert.equal(closed, 1);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.deepEqual(engine.getSnapshot('cleanup')?.result, result);
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test(
  '终态FIFO淘汰不影响运行中执行，同名启动不能覆盖活动记录',
  { timeout: 3000 },
  async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const parked: AgentLoop = {
      async *run() {
        yield { type: 'loop_start' };
        await gate;
        yield {
          type: 'loop_end',
          result: { status: 'completed', output: 'parked done' },
        };
      },
    };
    const quick: AgentLoop = {
      async *run() {
        yield { type: 'loop_start' };
        yield {
          type: 'loop_end',
          result: { status: 'completed', output: 'quick done' },
        };
      },
    };
    const engine = new DefaultExecutionEngine({
      logger,
      maxRetainedSnapshots: 1,
    });
    const stream = engine.execute({
      executionId: 'active',
      loop: parked,
      context: context(),
    });
    const iterator = stream[Symbol.asyncIterator]();
    assert.equal((await iterator.next()).value.type, 'execution_start');
    await iterator.next();
    const pending = iterator.next();
    try {
      await assert.rejects(
        collect(
          engine.execute({
            executionId: 'active',
            loop: quick,
            context: context(),
          }),
        ),
        /already registered/,
      );
      await collect(
        engine.execute({ executionId: 'one', loop: quick, context: context() }),
      );
      await collect(
        engine.execute({ executionId: 'two', loop: quick, context: context() }),
      );
      assert.equal(engine.getSnapshot('one'), undefined);
      assert.equal(engine.getSnapshot('two')?.status, 'COMPLETED');
      const active = engine.getSnapshot('active');
      assert.equal(active?.status, 'RUNNING');
      assert.equal(Object.hasOwn(active!, 'endedAt'), false);
      assert.equal(Object.hasOwn(active!, 'result'), false);
      release();
      assert.equal((await pending).value.type, 'loop_event');
      assert.equal((await iterator.next()).value.type, 'execution_end');
      assert.equal(engine.getSnapshot('two'), undefined);
      assert.equal(engine.getSnapshot('active')?.status, 'COMPLETED');
      assert.equal(engine.cancel('active'), false);
    } finally {
      release();
      await pending.catch(() => {});
      await iterator.return?.();
    }
  },
);
