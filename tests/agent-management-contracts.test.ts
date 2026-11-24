import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AgentManager,
  CreateSessionOptions,
  SessionAgent,
  SessionExecution,
  SessionSubmitOptions,
  SessionSummary,
} from '../src/harness/contracts/agent/index.ts';
import type {
  AgentLoop,
  AgentLoopContext,
} from '../src/harness/contracts/agent-loop/index.ts';
import type {
  ExecutionEvent,
  ExecutionResult,
} from '../src/harness/contracts/execution/index.ts';
import type { ModelParameters } from '../src/harness/contracts/model/index.ts';

const context: AgentLoopContext['context'] = { messages: [] };
const localLoop: AgentLoop = {
  async *run(input) {
    yield { type: 'loop_start' };
    yield {
      type: 'loop_end',
      result: { status: 'completed', output: input.input.content },
    };
  },
};

test('Session 创建契约复用 CustomLoop 与旧 Context，无模型和工具配置要求', () => {
  const options: CreateSessionOptions = {
    loop: localLoop,
    context,
    config: {},
  };
  const defaults: CreateSessionOptions = {};
  assert.equal(options.loop, localLoop);
  assert.equal(options.context, context);
  assert.deepEqual(options.config, {});
  assert.equal(Object.hasOwn(defaults, 'loop'), false);
  assert.equal(Object.hasOwn(options.config!, 'model'), false);
});

test('提交覆盖允许只给模型参数或工具空名单，不加入每次提交的 Loop 替换字段', () => {
  const parameters: ModelParameters = {
    temperature: 0.7,
    maxOutputTokens: 512,
    seed: 42,
  };
  const options: SessionSubmitOptions = {
    config: {
      model: { parameters },
      tools: { allowedNames: [] },
      extensions: { customLoop: { policy: 'local' } },
    },
  };
  assert.equal(options.config?.model?.parameters, parameters);
  assert.equal(options.config?.model?.name, undefined);
  assert.deepEqual(options.config?.tools?.allowedNames, []);
  assert.deepEqual(options.config?.extensions, {
    customLoop: { policy: 'local' },
  });
  type Assignable<From, To> = [From] extends [To] ? true : false;
  const hasLoopOverride: Assignable<'loop', keyof SessionSubmitOptions> = false;
  assert.equal(hasLoopOverride, false);
});

test('SessionExecution 的最终结果可独立等待，事件复用已有 ExecutionEvent', async () => {
  let observed = false;
  const final: ExecutionResult = {
    status: 'COMPLETED',
    loopResult: { status: 'completed', output: 'local result' },
  };
  const ending: ExecutionEvent = {
    type: 'execution_end',
    executionId: 'execution_fixture',
    timestamp: '2026-11-24T00:00:00.000Z',
    result: final,
  };
  const handle: SessionExecution = {
    executionId: 'execution_fixture',
    events: {
      async *[Symbol.asyncIterator]() {
        observed = true;
        yield ending;
      },
    },
    result: Promise.resolve(final),
  };
  assert.equal(await handle.result, final);
  assert.equal(observed, false);
  const events: ExecutionEvent[] = [];
  for await (const event of handle.events) events.push(event);
  assert.equal(observed, true);
  assert.equal(events[0], ending);
});

test('SessionExecution 的业务失败和排队取消均使用标准结果而非新错误状态', async () => {
  const results: ExecutionResult[] = [
    {
      status: 'FAILED',
      error: {
        code: 'internal_error',
        message: 'Execution could not complete.',
      },
    },
    { status: 'CANCELLED', reason: 'cancelled_while_queued' },
  ];
  for (const result of results) {
    const handle: SessionExecution = {
      executionId: `fixture_${result.status}`,
      events: { async *[Symbol.asyncIterator]() {} },
      result: Promise.resolve(result),
    };
    assert.equal(await handle.result, result);
    const events: ExecutionEvent[] = [];
    for await (const event of handle.events) events.push(event);
    assert.deepEqual(events, []);
  }
});

test('Manager 摘要支持空闲与运行观察，不泄露公共队列或新增 ExecutionStatus', () => {
  const idle: SessionSummary = {
    sessionId: 'session_fixture',
    createdAt: '2026-11-24T00:00:00.000Z',
    queuedCount: 0,
  };
  const running: SessionSummary = {
    ...idle,
    runningExecutionId: 'execution_fixture',
    queuedCount: 2,
  };
  assert.equal(Object.hasOwn(idle, 'runningExecutionId'), false);
  assert.equal(running.queuedCount, 2);
  type Assignable<From, To> = [From] extends [To] ? true : false;
  const checks: [
    Assignable<ReturnType<AgentManager['createSession']>, SessionAgent>,
    Assignable<
      ReturnType<AgentManager['getSession']>,
      SessionAgent | undefined
    >,
    Assignable<ReturnType<AgentManager['listSessions']>, SessionSummary[]>,
    Assignable<ReturnType<AgentManager['deleteSession']>, Promise<boolean>>,
    Assignable<ReturnType<SessionAgent['submit']>, SessionExecution>,
    Assignable<
      ReturnType<SessionAgent['getContext']>,
      AgentLoopContext['context']
    >,
    Assignable<ReturnType<SessionAgent['cancel']>, boolean>,
    Assignable<ReturnType<SessionAgent['getModel']>, string | undefined>,
    Assignable<ReturnType<SessionAgent['setModel']>, void>,
    Assignable<Promise<SessionExecution>, ReturnType<SessionAgent['submit']>>,
  ] = [true, true, true, true, true, true, true, true, true, false];
  assert.deepEqual(checks, [
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    true,
    false,
  ]);
});

test('Session 标识与执行句柄的公开属性保持 readonly', () => {
  type Equal<A, B> =
    (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
      ? true
      : false;
  const checks: [
    Equal<Pick<SessionAgent, 'sessionId'>, { readonly sessionId: string }>,
    Equal<
      Pick<SessionExecution, 'executionId'>,
      { readonly executionId: string }
    >,
    Equal<
      Pick<SessionExecution, 'events'>,
      { readonly events: AsyncIterable<ExecutionEvent> }
    >,
    Equal<
      Pick<SessionExecution, 'result'>,
      { readonly result: Promise<ExecutionResult> }
    >,
  ] = [true, true, true, true];
  assert.deepEqual(checks, [true, true, true, true]);
});
