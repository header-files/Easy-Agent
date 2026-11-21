import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ModelToolCall,
  ModelToolDefinition,
} from '../src/harness/contracts/model/index.ts';
import { ToolExecutionError } from '../src/harness/contracts/tool/index.ts';
import type {
  RegisteredTool,
  ToolCall,
  ToolErrorCode,
  ToolExecutionContext,
  ToolExecutionOptions,
  ToolExecutor,
  ToolHandler,
  ToolHandlerOutput,
  ToolRegistry,
  ToolResult,
  ToolSpec,
} from '../src/harness/contracts/tool/index.ts';

const spec: ToolSpec = {
  name: 'echo',
  description: 'Return the supplied text',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
};

test('ToolCall 与 ModelToolCall 双向结构兼容，工具声明复用模型字段形态', () => {
  const modelCall: ModelToolCall = {
    id: 'call_1',
    name: 'echo',
    argumentsJson: '{"text":"hello"}',
  };
  const toolCall: ToolCall = modelCall;
  const roundTrip: ModelToolCall = toolCall;
  const modelDefinition: ModelToolDefinition = spec;

  type Assignable<From, To> = [From] extends [To] ? true : false;
  const checks: [
    Assignable<ModelToolCall, ToolCall>,
    Assignable<ToolCall, ModelToolCall>,
    Assignable<{ id: string; name: string; argumentsJson: object }, ToolCall>,
    Assignable<{ content: number }, ToolHandlerOutput>,
    Assignable<'timeout', ToolErrorCode>,
  ] = [true, true, false, false, false];

  assert.equal(roundTrip, modelCall);
  assert.equal(modelDefinition.parameters, spec.parameters);
  assert.deepEqual(checks, [true, true, false, false, false]);
});

test('ToolHandler 支持同步和异步函数，共享统一参数与调用上下文', async () => {
  const args: Record<string, unknown> = { text: 'hello' };
  const context: ToolExecutionContext = {
    toolCallId: 'call_handlers',
    signal: new AbortController().signal,
  };
  const seen: ToolExecutionContext[] = [];
  const synchronous: ToolHandler = (input, execution) => {
    seen.push(execution);
    return { content: String(input.text) };
  };
  const asynchronous: ToolHandler = async (input, execution) => {
    seen.push(execution);
    return { content: `${execution.toolCallId}:${String(input.text)}` };
  };

  assert.deepEqual(await synchronous(args, context), { content: 'hello' });
  assert.deepEqual(await asynchronous(args, context), {
    content: 'call_handlers:hello',
  });
  assert.deepEqual(seen, [context, context]);
  assert.equal(seen[0]?.signal, context.signal);
});

test('RegisteredTool 与 Registry 方法保持实现无关的函数与声明契约', () => {
  const handler: ToolHandler = () => ({ content: 'ready' });
  const registered: RegisteredTool = { spec, handler };
  type Assignable<From, To> = [From] extends [To] ? true : false;
  const checks: [
    Assignable<Parameters<ToolRegistry['register']>, [ToolSpec, ToolHandler]>,
    Assignable<ReturnType<ToolRegistry['get']>, RegisteredTool | undefined>,
    Assignable<ReturnType<ToolRegistry['list']>, ToolSpec[]>,
    Assignable<ReturnType<ToolRegistry['unregister']>, boolean>,
  ] = [true, true, true, true];

  assert.equal(registered.handler, handler);
  assert.deepEqual(checks, [true, true, true, true]);
});

test('ToolResult 以 status 收窄，业务失败携带错误信息而不是取消码', () => {
  const success: ToolResult = {
    toolCallId: 'success_id',
    name: 'echo',
    status: 'success',
    content: 'hello',
  };
  const failure: ToolResult = {
    toolCallId: 'failure_id',
    name: 'echo',
    status: 'error',
    content: 'Tool execution failed.',
    error: { code: 'execution_failed', message: 'Tool execution failed.' },
  };
  const summary = (result: ToolResult): string =>
    result.status === 'success'
      ? result.content
      : `${result.error.code}:${result.toolCallId}`;
  type Assignable<From, To> = [From] extends [To] ? true : false;
  const checks: [
    Assignable<
      { toolCallId: string; name: string; status: 'error'; content: string },
      ToolResult
    >,
    Assignable<
      { toolCallId: string; name: string; status: 'success'; content: string },
      ToolResult
    >,
    Assignable<'aborted', ToolErrorCode>,
  ] = [false, true, false];

  assert.equal(summary(success), 'hello');
  assert.equal(summary(failure), 'execution_failed:failure_id');
  assert.deepEqual(checks, [false, true, false]);
});

test('ToolExecutor 可由类或对象替换，execute 返回 Promise 并接收执行选项', async () => {
  const call: ToolCall = {
    id: 'call_executor',
    name: 'echo',
    argumentsJson: '{}',
  };
  const options: ToolExecutionOptions = {
    timeoutMs: 1000,
    signal: new AbortController().signal,
  };
  const result: ToolResult = {
    toolCallId: call.id,
    name: call.name,
    status: 'success',
    content: 'ready',
  };
  const seen: ToolExecutionOptions[] = [];
  class FixedExecutor implements ToolExecutor {
    async execute(
      _call: ToolCall,
      execution?: ToolExecutionOptions,
    ): Promise<ToolResult> {
      if (execution) seen.push(execution);
      return result;
    }
  }
  const alternative: ToolExecutor = {
    execute: async (_call, execution) => {
      if (execution) seen.push(execution);
      return result;
    },
  };
  for (const executor of [new FixedExecutor(), alternative]) {
    const pending: Promise<ToolResult> = executor.execute(call, options);
    assert.equal(await pending, result);
  }
  assert.deepEqual(seen, [options, options]);
});

test('取消与超时使用独立 ToolExecutionError，并保留标准 Error 身份', async () => {
  for (const code of ['aborted', 'timeout'] as const) {
    const error = new ToolExecutionError(code, `Tool execution ${code}.`);
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'ToolExecutionError');
    assert.equal(error.code, code);
    assert.equal(error.message, `Tool execution ${code}.`);
    assert.equal(Object.hasOwn(error, 'code'), true);
    const executor: ToolExecutor = {
      execute: async () => {
        throw error;
      },
    };
    await assert.rejects(
      executor.execute({ id: 'control', name: 'echo', argumentsJson: '{}' }),
      (caught: unknown) => caught === error,
    );
  }
});
