import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AgentLoop,
  AgentLoopContext,
  AgentLoopEvent,
  AgentLoopResult,
} from '../src/harness/contracts/agent-loop/index.ts';
import type {
  ExecutionEngine,
  ExecutionErrorCode,
  ExecutionErrorInfo,
  ExecutionEvent,
  ExecutionRequest,
  ExecutionResult,
  ExecutionSnapshot,
  ExecutionStatus,
} from '../src/harness/contracts/execution/index.ts';

const context: AgentLoopContext = {
  input: { content: 'local input' },
  context: { messages: [] },
  config: {},
  control: { signal: new AbortController().signal },
};

test('ExecutionRequest 直接接收无模型工具依赖的自定义 AgentLoop 与既有 Context', async () => {
  const local: AgentLoop = {
    run: async function* (input) {
      yield { type: 'loop_start' };
      yield {
        type: 'custom_event',
        name: 'local.ready',
        data: { local: true },
      };
      yield {
        type: 'loop_end',
        result: { status: 'completed', output: input.input.content },
      };
    },
  };
  const request: ExecutionRequest = {
    executionId: 'execution_fixture',
    loop: local,
    context,
  };
  const events: AgentLoopEvent[] = [];
  for await (const event of request.loop.run(request.context))
    events.push(event);

  assert.equal(request.context, context);
  assert.equal(Object.hasOwn(context.config, 'model'), false);
  assert.equal(Object.hasOwn(context.config, 'tools'), false);
  assert.deepEqual(events.at(-1), {
    type: 'loop_end',
    result: { status: 'completed', output: 'local input' },
  });
});

test('ExecutionEvent 包装既有 Loop 事件，不替换其事件类型或数据载荷', () => {
  const data = { date: new Date('2026-11-23T00:00:00Z'), callback: () => 42 };
  const loopEvent: AgentLoopEvent = {
    type: 'custom_event',
    name: 'custom.payload',
    data,
  };
  const loopResult: AgentLoopResult = { status: 'completed', output: 'done' };
  const events: ExecutionEvent[] = [
    {
      type: 'execution_start',
      executionId: 'execution_fixture',
      timestamp: '2026-11-23T00:00:00.000Z',
    },
    { type: 'loop_event', executionId: 'execution_fixture', event: loopEvent },
    {
      type: 'execution_end',
      executionId: 'execution_fixture',
      timestamp: '2026-11-23T00:00:01.000Z',
      result: { status: 'COMPLETED', loopResult },
    },
  ];
  const wrapped = events[1];
  assert.equal(wrapped?.type, 'loop_event');
  if (wrapped?.type !== 'loop_event') throw new Error();
  assert.equal(wrapped.event, loopEvent);
  if (wrapped.event.type !== 'custom_event') throw new Error();
  assert.equal(wrapped.event.data, data);
  assert.deepEqual(
    events.map((event) => event.type),
    ['execution_start', 'loop_event', 'execution_end'],
  );
});

test('ExecutionResult 联合保留 LoopResult，stopped 与 Execution FAILED 分层表达', () => {
  const loopResult: AgentLoopResult = {
    status: 'stopped',
    reason: 'custom_policy',
    output: 'partial',
  };
  const safeError: ExecutionErrorInfo = {
    code: 'loop_stopped',
    message: 'Loop stopped without completion.',
  };
  const results: ExecutionResult[] = [
    {
      status: 'COMPLETED',
      loopResult: { status: 'completed', output: 'done' },
    },
    { status: 'FAILED', error: safeError, loopResult },
    {
      status: 'FAILED',
      error: { code: 'loop_error', message: 'Loop execution failed.' },
    },
    { status: 'CANCELLED' },
    { status: 'CANCELLED', reason: 'Cancellation was requested.' },
  ];
  const summary = results.map((result) => {
    switch (result.status) {
      case 'COMPLETED':
        return result.loopResult.output;
      case 'FAILED':
        return result.error.code;
      case 'CANCELLED':
        return result.reason ?? 'cancelled';
      default: {
        const exhaustive: never = result;
        return exhaustive;
      }
    }
  });
  assert.deepEqual(summary, [
    'done',
    'loop_stopped',
    'loop_error',
    'cancelled',
    'Cancellation was requested.',
  ]);
  const failed = results[1];
  if (failed?.status !== 'FAILED') throw new Error();
  assert.equal(failed.loopResult, loopResult);
  assert.equal(loopResult.status, 'stopped');
});

test('快照形态允许运行中省略终态数据，并保留 ISO 时间和耗时字段', () => {
  const running: ExecutionSnapshot = {
    executionId: 'execution_fixture',
    status: 'RUNNING',
    startedAt: '2026-11-23T00:00:00.000Z',
  };
  const terminal: ExecutionSnapshot = {
    ...running,
    status: 'COMPLETED',
    endedAt: '2026-11-23T00:00:01.000Z',
    durationMs: 1000,
    result: {
      status: 'COMPLETED',
      loopResult: {
        status: 'completed',
        output: 'done',
        updatedContext: context.context,
      },
    },
  };
  const states: ExecutionStatus[] = [
    'RUNNING',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
  ];
  assert.equal(Object.hasOwn(running, 'endedAt'), false);
  assert.equal(Object.hasOwn(running, 'result'), false);
  assert.equal(terminal.result?.status, terminal.status);
  assert.equal(terminal.durationMs, 1000);
  assert.equal(states.includes(running.status), true);
});

test('Engine 方法保持惰性异步流、取消布尔值和可缺省快照的静态协议', () => {
  type Assignable<From, To> = [From] extends [To] ? true : false;
  const checks: [
    Assignable<Parameters<ExecutionEngine['execute']>, [ExecutionRequest]>,
    Assignable<
      ReturnType<ExecutionEngine['execute']>,
      AsyncIterable<ExecutionEvent>
    >,
    Assignable<ReturnType<ExecutionEngine['cancel']>, boolean>,
    Assignable<
      ReturnType<ExecutionEngine['getSnapshot']>,
      ExecutionSnapshot | undefined
    >,
    Assignable<{ status: 'COMPLETED' }, ExecutionResult>,
    Assignable<
      { status: 'FAILED'; loopResult: AgentLoopResult },
      ExecutionResult
    >,
    Assignable<'CANCELLING' | 'QUEUED', ExecutionStatus>,
    Assignable<'timeout' | 'aborted', ExecutionErrorCode>,
  ] = [true, true, true, true, false, false, false, false];
  assert.deepEqual(checks, [
    true,
    true,
    true,
    true,
    false,
    false,
    false,
    false,
  ]);
});
