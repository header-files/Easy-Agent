import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AgentLoop,
  AgentLoopContext,
  AgentLoopEvent,
  AgentLoopResult,
} from '../src/harness/contracts/agent-loop/index.ts';
import type {
  ModelMessage,
  ModelParameters,
  ModelStreamEvent,
  ModelToolCall,
} from '../src/harness/contracts/model/index.ts';
import type {
  ToolCall,
  ToolResult,
} from '../src/harness/contracts/tool/index.ts';

const context: AgentLoopContext = {
  input: { content: 'hello' },
  context: { messages: [] },
  config: {},
  control: { signal: new AbortController().signal },
};

async function collect(
  events: AsyncIterable<AgentLoopEvent>,
): Promise<AgentLoopEvent[]> {
  const result: AgentLoopEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

test('自定义 Loop 无需模型、工具或默认实现，最终结果无需模型统计', async () => {
  class LocalLoop implements AgentLoop {
    async *run(input: AgentLoopContext): AsyncIterable<AgentLoopEvent> {
      yield { type: 'loop_start' };
      yield {
        type: 'custom_event',
        name: 'local.input_checked',
        data: { length: input.input.content.length },
      };
      yield { type: 'output_delta', content: input.input.content };
      yield {
        type: 'loop_end',
        result: { status: 'completed', output: input.input.content },
      };
    }
  }
  const alternative: AgentLoop = {
    run: async function* (input) {
      yield { type: 'loop_start' };
      yield {
        type: 'loop_end',
        result: {
          status: 'stopped',
          reason: 'local_policy',
          output: input.input.content,
        },
      };
    },
  };

  const localEvents = await collect(new LocalLoop().run(context));
  assert.deepEqual(
    localEvents.map((event) => event.type),
    ['loop_start', 'custom_event', 'output_delta', 'loop_end'],
  );
  assert.deepEqual(localEvents.at(-1), {
    type: 'loop_end',
    result: { status: 'completed', output: 'hello' },
  });
  const otherEvents = await collect(alternative.run(context));
  assert.deepEqual(otherEvents.at(-1), {
    type: 'loop_end',
    result: { status: 'stopped', reason: 'local_policy', output: 'hello' },
  });
});

test('Context 复用既有模型参数与只读历史，专属配置通过 extensions 承载', () => {
  const history: readonly ModelMessage[] = [
    { role: 'user', content: 'earlier' },
    { role: 'assistant', content: 'earlier answer' },
  ];
  const parameters: ModelParameters = {
    temperature: 0.5,
    maxOutputTokens: 512,
    seed: 42,
  };
  const configured: AgentLoopContext = {
    ...context,
    context: { messages: history, data: { language: 'zh' } },
    config: {
      model: { name: 'example-model', parameters },
      tools: { allowedNames: ['echo'] },
      extensions: { customLoop: { strategy: 'local' } },
    },
    metadata: {
      sessionId: 'session_fixture',
      executionId: 'execution_fixture',
    },
  };
  assert.equal(configured.context.messages, history);
  assert.equal(configured.config.model?.parameters, parameters);
  assert.deepEqual(configured.config.extensions, {
    customLoop: { strategy: 'local' },
  });
  assert.equal(Object.hasOwn(context.config, 'model'), false);
  assert.equal(Object.hasOwn(context.config, 'tools'), false);
});

test('事件直接承载既有 ModelStreamEvent、ToolCall 与 ToolResult，无协议重定义', () => {
  const modelEvent: ModelStreamEvent = { type: 'text_delta', text: 'checking' };
  const modelCall: ModelToolCall = {
    id: 'call_fixture',
    name: 'echo',
    argumentsJson: '{}',
  };
  const call: ToolCall = modelCall;
  const toolResult: ToolResult = {
    toolCallId: call.id,
    name: call.name,
    status: 'error',
    content: 'Invalid arguments.',
    error: { code: 'invalid_arguments', message: 'Invalid arguments.' },
  };
  const events: AgentLoopEvent[] = [
    { type: 'model_event', modelCallIndex: 1, event: modelEvent },
    { type: 'tool_start', modelCallIndex: 1, call },
    { type: 'tool_result', modelCallIndex: 1, result: toolResult },
  ];
  const first = events[0];
  if (first?.type === 'model_event') assert.equal(first.event, modelEvent);
  const second = events[1];
  if (second?.type === 'tool_start') assert.equal(second.call, modelCall);
  const third = events[2];
  if (third?.type === 'tool_result') assert.equal(third.result, toolResult);
});

test('结果联合区分 completed/stopped，完整上下文与 details 都可选', () => {
  const results: AgentLoopResult[] = [
    { status: 'completed', output: 'done' },
    { status: 'stopped', reason: 'custom_policy' },
    {
      status: 'completed',
      output: 'done',
      updatedContext: {
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'done' },
        ],
        data: { language: 'zh' },
      },
      details: { algorithm: 'custom' },
    },
  ];
  const summaries = results.map((result) =>
    result.status === 'completed' ? result.output : result.reason,
  );
  assert.deepEqual(summaries, ['done', 'custom_policy', 'done']);
  assert.equal(results[2]?.updatedContext?.messages.length, 2);
  assert.deepEqual(results[2]?.details, { algorithm: 'custom' });
});

test('静态契约拒绝旧事件、缺失最终输出/停止原因和非 AsyncIterable 返回值', () => {
  type Assignable<From, To> = [From] extends [To] ? true : false;
  const checks: [
    Assignable<
      { type: 'loop_result'; result: AgentLoopResult },
      AgentLoopEvent
    >,
    Assignable<{ status: 'completed' }, AgentLoopResult>,
    Assignable<{ status: 'stopped'; output: string }, AgentLoopResult>,
    Assignable<
      { run(context: AgentLoopContext): Promise<AgentLoopResult> },
      AgentLoop
    >,
    Assignable<'getResult', keyof AgentLoop>,
    Assignable<'maxModelCalls', keyof AgentLoopContext['config']>,
    Assignable<ReturnType<AgentLoop['run']>, AsyncIterable<AgentLoopEvent>>,
  ] = [false, false, false, false, false, false, true];
  assert.deepEqual(checks, [false, false, false, false, false, false, true]);
});

test('异常经同一异步迭代传播，不伪造正常 loop_end', async () => {
  const failure = new Error('contract fixture failure');
  const failing: AgentLoop = {
    run: async function* () {
      yield { type: 'loop_start' };
      throw failure;
    },
  };
  const received: AgentLoopEvent[] = [];
  await assert.rejects(
    async () => {
      for await (const event of failing.run(context)) received.push(event);
    },
    (error: unknown) => error === failure,
  );
  assert.deepEqual(received, [{ type: 'loop_start' }]);
});
