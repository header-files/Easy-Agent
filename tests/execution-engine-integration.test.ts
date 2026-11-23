import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLogger,
  DefaultAgentLoop,
  DefaultExecutionEngine,
  DefaultToolExecutor,
  DefaultToolRegistry,
  ModelError,
  type AgentLoopContext,
  type ExecutionEvent,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamEvent,
} from '../src/index.ts';

const logger = createLogger({ destination: { write() {} } });
function context(): AgentLoopContext {
  return {
    input: { content: 'question' },
    context: { messages: [] },
    config: { model: { name: 'offline-model' } },
    control: { signal: new AbortController().signal },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function* stream(
  response: ModelResponse,
): AsyncGenerator<ModelStreamEvent> {
  yield { type: 'message_start', model: response.model };
  if (response.message.content)
    yield { type: 'text_delta', text: response.message.content };
  yield { type: 'message_end', response };
}
async function collect(source: AsyncIterable<ExecutionEvent>) {
  const events: ExecutionEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}
function end(events: ExecutionEvent[]) {
  const last = events.at(-1);
  assert.equal(last?.type, 'execution_end');
  if (last?.type !== 'execution_end') throw new Error();
  return last.result;
}

test('Engine通过既有DefaultAgentLoop完成模型工具闭环，仅包装事件和管理Execution状态', async () => {
  const requests: ModelRequest[] = [];
  const model: ModelClient = {
    generate() {
      throw new Error('Only stream is supported by the default policy');
    },
    stream(request) {
      requests.push(structuredClone(request));
      return stream(
        requests.length === 1
          ? {
              model: 'offline-model',
              message: {
                role: 'assistant',
                content: null,
                toolCalls: [
                  {
                    id: 'call',
                    name: 'echo',
                    argumentsJson: '{"text":"tool input"}',
                  },
                ],
              },
              finishReason: 'tool_calls',
            }
          : {
              model: 'offline-model',
              message: { role: 'assistant', content: 'final answer' },
              finishReason: 'stop',
            },
      );
    },
  };
  let tools = 0;
  const registry = new DefaultToolRegistry();
  registry.register(
    {
      name: 'echo',
      description: 'Echo',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
    },
    (args) => {
      tools++;
      return { content: String(args.text) };
    },
  );
  const loop = new DefaultAgentLoop(
    model,
    registry,
    new DefaultToolExecutor(registry, { logger }),
  );
  const engine = new DefaultExecutionEngine({ logger });
  const events = await collect(
    engine.execute({ executionId: 'default-loop', loop, context: context() }),
  );
  const result = end(events);
  assert.equal(result.status, 'COMPLETED');
  if (result.status !== 'COMPLETED') throw new Error();
  assert.equal(result.loopResult.output, 'final answer');
  assert.deepEqual(result.loopResult.details, {
    modelCalls: 2,
    modelRetries: 0,
    toolCalls: 1,
  });
  assert.equal(tools, 1);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1]?.messages, [
    { role: 'user', content: 'question' },
    {
      role: 'assistant',
      content: null,
      toolCalls: [
        { id: 'call', name: 'echo', argumentsJson: '{"text":"tool input"}' },
      ],
    },
    { role: 'tool', toolCallId: 'call', content: 'tool input', isError: false },
  ]);
  const forwarded = events.flatMap((event) =>
    event.type === 'loop_event' ? [event.event] : [],
  );
  assert.equal(forwarded[0]?.type, 'loop_start');
  assert.equal(forwarded.at(-1)?.type, 'loop_end');
  assert.deepEqual(
    forwarded
      .filter((event) => event.type === 'output_delta')
      .map((event) => event.content),
    ['final answer'],
  );
  assert.equal(
    forwarded.filter((event) => event.type === 'tool_start').length,
    1,
  );
  assert.equal(
    forwarded.filter((event) => event.type === 'tool_result').length,
    1,
  );
  assert.deepEqual(engine.getSnapshot('default-loop')?.result, result);
});

test(
  'Engine取消会传入既有DefaultAgentLoop并收尾模型迭代器，不依赖异常名称猜测取消',
  { timeout: 3000 },
  async () => {
    const ready = deferred<void>();
    let closed = 0;
    let receivedSignal: AbortSignal | undefined;
    let removeListener = () => {};
    const model: ModelClient = {
      generate() {
        throw new Error();
      },
      async *stream(_request, options) {
        receivedSignal = options?.signal;
        assert.ok(receivedSignal);
        const signal = receivedSignal;
        try {
          yield { type: 'message_start', model: 'offline-model' };
          await new Promise<void>((_resolve, reject) => {
            const abort = () =>
              reject(
                new ModelError({
                  code: 'aborted',
                  message: 'private dependency error',
                  retryable: false,
                }),
              );
            removeListener = () => signal.removeEventListener('abort', abort);
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
            ready.resolve();
          });
        } finally {
          removeListener();
          closed++;
        }
      },
    };
    const registry = new DefaultToolRegistry();
    const loop = new DefaultAgentLoop(
      model,
      registry,
      new DefaultToolExecutor(registry, { logger }),
    );
    const engine = new DefaultExecutionEngine({ logger });
    const source = context();
    const task = collect(
      engine.execute({ executionId: 'cancel-default', loop, context: source }),
    );
    try {
      await ready.promise;
      assert.equal(engine.cancel('cancel-default'), true);
      const events = await task;
      assert.equal(end(events).status, 'CANCELLED');
      assert.equal(receivedSignal?.aborted, true);
      assert.equal(source.control.signal.aborted, false);
      assert.equal(closed, 1);
      assert.equal(
        events.some(
          (event) =>
            event.type === 'loop_event' && event.event.type === 'loop_end',
        ),
        false,
      );
      assert.equal(
        JSON.stringify(events).includes('private dependency error'),
        false,
      );
      assert.deepEqual(
        engine.getSnapshot('cancel-default')?.result,
        end(events),
      );
    } finally {
      engine.cancel('cancel-default');
      removeListener();
      await task;
    }
  },
);

test('DefaultAgentLoop的length停止保留原LoopResult，由Engine映射FAILED而不执行截断工具', async () => {
  const model: ModelClient = {
    generate() {
      throw new Error();
    },
    stream() {
      return stream({
        model: 'offline-model',
        message: {
          role: 'assistant',
          content: 'partial',
          toolCalls: [{ id: 'incomplete', name: 'echo', argumentsJson: '{' }],
        },
        finishReason: 'length',
      });
    },
  };
  let invoked = 0;
  const registry = new DefaultToolRegistry();
  registry.register(
    { name: 'echo', description: 'Echo', parameters: { type: 'object' } },
    () => {
      invoked++;
      return { content: 'unexpected' };
    },
  );
  const loop = new DefaultAgentLoop(
    model,
    registry,
    new DefaultToolExecutor(registry, { logger }),
  );
  const engine = new DefaultExecutionEngine({ logger });
  const result = end(
    await collect(
      engine.execute({
        executionId: 'stopped-default',
        loop,
        context: context(),
      }),
    ),
  );
  assert.equal(result.status, 'FAILED');
  if (result.status !== 'FAILED' || result.loopResult?.status !== 'stopped')
    throw new Error();
  assert.equal(result.error.code, 'loop_stopped');
  assert.equal(result.loopResult.reason, 'length');
  assert.equal(result.loopResult.output, 'partial');
  assert.deepEqual(result.loopResult.updatedContext?.messages, [
    { role: 'user', content: 'question' },
  ]);
  assert.equal(invoked, 0);
  assert.deepEqual(engine.getSnapshot('stopped-default')?.result, result);
});
