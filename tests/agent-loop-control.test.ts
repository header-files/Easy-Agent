import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import type {
  AgentLoopContext,
  AgentLoopEvent,
} from '../src/harness/contracts/agent-loop/index.ts';
import {
  ModelError,
  type ModelClient,
  type ModelResponse,
  type ModelStreamEvent,
} from '../src/harness/contracts/model/index.ts';
import {
  ToolExecutionError,
  type ToolCall,
  type ToolExecutor,
  type ToolRegistry,
  type ToolResult,
} from '../src/harness/contracts/tool/index.ts';
import { DefaultAgentLoop } from '../src/execution/loops/index.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Controlled loop operation did not settle.')),
          1000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function source(
  content = 'question',
  signal = new AbortController().signal,
): AgentLoopContext {
  return {
    input: { content },
    context: { messages: [] },
    config: { model: { name: 'control-model' } },
    control: { signal },
  };
}

function registry(onList: () => void = () => {}): ToolRegistry {
  return {
    register() {},
    unregister: () => false,
    get: () => undefined,
    list() {
      onList();
      return [
        { name: 'echo', description: 'Echo', parameters: { type: 'object' } },
      ];
    },
  };
}

function success(call: ToolCall): ToolResult {
  return {
    toolCallId: call.id,
    name: call.name,
    status: 'success',
    content: `result:${call.id}`,
  };
}

const tools: ToolExecutor = { execute: async (call) => success(call) };

function response(content: string | null, calls?: ToolCall[]): ModelResponse {
  return {
    model: 'control-model',
    message: {
      role: 'assistant',
      content,
      ...(calls === undefined ? {} : { toolCalls: calls }),
    },
    finishReason: calls === undefined ? 'stop' : 'tool_calls',
  };
}

async function* completed(
  value: ModelResponse,
): AsyncGenerator<ModelStreamEvent> {
  yield { type: 'message_start', model: value.model };
  if (value.message.content)
    yield { type: 'text_delta', text: value.message.content };
  yield { type: 'message_end', response: value };
}

function model(stream: ModelClient['stream']): ModelClient {
  return {
    generate() {
      throw new Error('DefaultAgentLoop must not call generate.');
    },
    stream,
  };
}

async function collect(
  events: AsyncIterable<AgentLoopEvent>,
): Promise<AgentLoopEvent[]> {
  const received: AgentLoopEvent[] = [];
  for await (const event of events) received.push(event);
  return received;
}

async function close(iterator: AsyncIterator<AgentLoopEvent>) {
  assert.equal(typeof iterator.return, 'function');
  return iterator.return!();
}

function isAborted(error: unknown): boolean {
  return (
    (error instanceof ModelError || error instanceof ToolExecutionError) &&
    error.code === 'aborted'
  );
}

test('run 未消费及未启动即 return 不触发模型、工具或 Registry 副作用', async () => {
  let listed = 0;
  let modelCalls = 0;
  let toolCalls = 0;
  const loop = new DefaultAgentLoop(
    model(() => {
      modelCalls++;
      return completed(response('answer'));
    }),
    registry(() => {
      listed++;
    }),
    {
      execute: async (call) => {
        toolCalls++;
        return success(call);
      },
    },
  );
  const events = loop.run(source());
  const iterator = events[Symbol.asyncIterator]();
  assert.deepEqual([listed, modelCalls, toolCalls], [0, 0, 0]);
  assert.equal((await bounded(close(iterator))).done, true);
  assert.deepEqual([listed, modelCalls, toolCalls], [0, 0, 0]);
});

test('预先取消直接传播控制异常，无开始/结束事件或能力调用', async () => {
  const controller = new AbortController();
  controller.abort(new Error('PRIVATE_PRE_ABORT_REASON'));
  let modelCalls = 0;
  let toolCalls = 0;
  const events: AgentLoopEvent[] = [];
  const loop = new DefaultAgentLoop(
    model(() => {
      modelCalls++;
      return completed(response('answer'));
    }),
    registry(),
    {
      execute: async (call) => {
        toolCalls++;
        return success(call);
      },
    },
  );
  await assert.rejects(async () => {
    for await (const event of loop.run(source('cancelled', controller.signal)))
      events.push(event);
  }, isAborted);
  assert.deepEqual(events, []);
  assert.deepEqual([modelCalls, toolCalls], [0, 0]);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test(
  '消费中外部取消中止 pending model.next，关闭流且不产生 loop_end',
  { timeout: 4000 },
  async () => {
    const controller = new AbortController();
    const entered = deferred<void>();
    const gate = deferred<IteratorResult<ModelStreamEvent>>();
    let effectiveSignal: AbortSignal | undefined;
    let closed = 0;
    let reads = 0;
    const loop = new DefaultAgentLoop(
      model((_request, options) => {
        effectiveSignal = options?.signal;
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (reads++ === 0)
                  return Promise.resolve({
                    done: false as const,
                    value: {
                      type: 'message_start' as const,
                      model: 'control-model',
                    },
                  });
                entered.resolve();
                return gate.promise;
              },
              async return() {
                closed++;
                gate.resolve({ done: true, value: undefined });
                return { done: true as const, value: undefined };
              },
            };
          },
        };
      }),
      registry(),
      tools,
    );
    const events: AgentLoopEvent[] = [];
    const consuming = (async () => {
      for await (const event of loop.run(source('cancel', controller.signal)))
        events.push(event);
    })();
    const rejected = assert.rejects(consuming, isAborted);
    try {
      await bounded(entered.promise);
      controller.abort(new Error('PRIVATE_ACTIVE_ABORT_REASON'));
      await bounded(rejected);
      assert.equal(effectiveSignal?.aborted, true);
      assert.equal(closed, 1);
      assert.equal(
        events.some((event) => event.type === 'loop_end'),
        false,
      );
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally {
      gate.resolve({ done: true, value: undefined });
      await consuming.catch(() => {});
    }
  },
);

test(
  'pending model.next 时 consumer return 及时取消独立 signal 并关闭底层 iterator',
  { timeout: 4000 },
  async () => {
    const external = new AbortController();
    const entered = deferred<void>();
    const gate = deferred<IteratorResult<ModelStreamEvent>>();
    let effectiveSignal: AbortSignal | undefined;
    let closed = 0;
    const loop = new DefaultAgentLoop(
      model((_request, options) => {
        effectiveSignal = options?.signal;
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                entered.resolve();
                return gate.promise;
              },
              async return() {
                closed++;
                gate.resolve({ done: true, value: undefined });
                return { done: true as const, value: undefined };
              },
            };
          },
        };
      }),
      registry(),
      tools,
    );
    const events = loop.run(source('return', external.signal));
    const iterator = events[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(first.value?.type, 'loop_start');
    const pending = iterator.next().then(
      (value) => ({ value }),
      (error) => ({ error: error as unknown }),
    );
    try {
      await bounded(entered.promise);
      assert.equal((await bounded(close(iterator))).done, true);
      const outcome = await bounded(pending);
      if ('value' in outcome) assert.equal(outcome.value.done, true);
      assert.equal(effectiveSignal?.aborted, true);
      assert.equal(external.signal.aborted, false);
      assert.equal(closed, 1);
      assert.equal(getEventListeners(external.signal, 'abort').length, 0);
      assert.equal((await iterator.next()).done, true);
    } finally {
      gate.resolve({ done: true, value: undefined });
      await bounded(close(iterator)).catch(() => {});
      await pending;
    }
  },
);

test(
  '模型流 finalizer 不合作时，暂停后 return 与验证失败均及时清理本地运行',
  { timeout: 4000 },
  async () => {
    for (const mode of ['consumer_return', 'invalid_response'] as const) {
      const external = new AbortController();
      const closing = deferred<void>();
      const closeGate = deferred<IteratorResult<ModelStreamEvent>>();
      let effectiveSignal: AbortSignal | undefined;
      let closed = 0;
      const loop = new DefaultAgentLoop(
        model((_request, options) => {
          effectiveSignal = options?.signal;
          return {
            [Symbol.asyncIterator]() {
              return {
                async next(): Promise<IteratorResult<ModelStreamEvent>> {
                  return {
                    done: false,
                    value:
                      mode === 'consumer_return'
                        ? { type: 'message_start', model: 'control-model' }
                        : { type: 'text_delta', text: 'missing message_start' },
                  };
                },
                return() {
                  closed++;
                  closing.resolve();
                  return closeGate.promise;
                },
              };
            },
          };
        }),
        registry(),
        tools,
      );
      const iterable = loop.run(source(mode, external.signal));
      const iterator = iterable[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).value?.type, 'loop_start');
      let terminal: Promise<unknown> | undefined;
      try {
        if (mode === 'consumer_return') {
          const event = await iterator.next();
          assert.equal(event.value?.type, 'model_event');
          terminal = close(iterator);
        } else {
          terminal = assert.rejects(
            iterator.next(),
            (error: unknown) =>
              error instanceof ModelError && error.code === 'invalid_response',
          );
        }
        await bounded(closing.promise);
        const result = await bounded(terminal);
        if (mode === 'consumer_return')
          assert.deepEqual(result, { done: true, value: undefined });
        assert.equal(closed, 1);
        assert.equal(effectiveSignal?.aborted, true);
        assert.equal(external.signal.aborted, false);
        assert.equal(getEventListeners(external.signal, 'abort').length, 0);
        assert.equal((await iterator.next()).done, true);
      } finally {
        closeGate.resolve({ done: true, value: undefined });
        await terminal?.catch(() => {});
        await bounded(close(iterator)).catch(() => {});
      }
    }
  },
);

test(
  'pending ToolExecutor 时 return 中止有效 signal，不执行后续工具或模型',
  { timeout: 4000 },
  async () => {
    const external = new AbortController();
    const entered = deferred<void>();
    const gate = deferred<ToolResult>();
    const calls: ToolCall[] = [
      { id: 'first', name: 'echo', argumentsJson: '{}' },
      { id: 'second', name: 'echo', argumentsJson: '{}' },
    ];
    let effectiveSignal: AbortSignal | undefined;
    let removeListener: (() => void) | undefined;
    let modelCalls = 0;
    const executed: string[] = [];
    const loop = new DefaultAgentLoop(
      model(() => {
        modelCalls++;
        return completed(response(null, calls));
      }),
      registry(),
      {
        execute: (call, options) => {
          executed.push(call.id);
          effectiveSignal = options?.signal;
          assert.ok(effectiveSignal);
          const signal = effectiveSignal;
          const aborted = () =>
            gate.reject(
              new ToolExecutionError('aborted', 'Tool execution was aborted.'),
            );
          signal.addEventListener('abort', aborted, { once: true });
          removeListener = () => signal.removeEventListener('abort', aborted);
          entered.resolve();
          return gate.promise.finally(() => removeListener?.());
        },
      },
    );
    const iterable = loop.run(source('tool return', external.signal));
    const iterator = iterable[Symbol.asyncIterator]();
    const events: AgentLoopEvent[] = [];
    while (true) {
      const event = await bounded(iterator.next());
      assert.equal(event.done, false);
      events.push(event.value);
      if (event.value.type === 'tool_start') break;
    }
    const pending = iterator.next().then(
      (value) => ({ value }),
      (error) => ({ error: error as unknown }),
    );
    try {
      await bounded(entered.promise);
      assert.equal((await bounded(close(iterator))).done, true);
      const outcome = await bounded(pending);
      if ('value' in outcome) assert.equal(outcome.value.done, true);
      assert.equal(effectiveSignal?.aborted, true);
      assert.equal(external.signal.aborted, false);
      assert.deepEqual(executed, ['first']);
      assert.equal(modelCalls, 1);
      assert.equal(
        events.some(
          (event) => event.type === 'tool_result' || event.type === 'loop_end',
        ),
        false,
      );
      assert.equal(getEventListeners(external.signal, 'abort').length, 0);
    } finally {
      removeListener?.();
      gate.resolve(success(calls[0]!));
      await bounded(close(iterator)).catch(() => {});
      await pending;
    }
  },
);

test('模型失败经同一流传播且不产生正常 loop_end', async () => {
  const failure = new ModelError({
    code: 'provider_error',
    message: 'Controlled provider failure.',
    retryable: false,
  });
  let closed = false;
  const events: AgentLoopEvent[] = [];
  const loop = new DefaultAgentLoop(
    model(async function* () {
      try {
        yield { type: 'message_start', model: 'control-model' };
        throw failure;
      } finally {
        closed = true;
      }
    }),
    registry(),
    tools,
  );
  await assert.rejects(
    async () => {
      for await (const event of loop.run(source())) events.push(event);
    },
    (error: unknown) => error === failure,
  );
  assert.equal(closed, true);
  assert.equal(
    events.some((event) => event.type === 'loop_end'),
    false,
  );
});

test(
  '同一实例两个 run 真实交错，取消一个不影响另一个的输出与上下文',
  { timeout: 4000 },
  async () => {
    const controllers = { a: new AbortController(), b: new AbortController() };
    const gates = { a: deferred<void>(), b: deferred<void>() };
    const arrived = deferred<void>();
    const effective = new Map<string, AbortSignal>();
    const closed: string[] = [];
    const loop = new DefaultAgentLoop(
      model((request, options) => {
        const input = request.messages.at(-1)?.content;
        assert.ok(input === 'a' || input === 'b');
        assert.ok(options?.signal);
        const signal = options.signal;
        effective.set(input, signal);
        if (effective.size === 2) arrived.resolve();
        return (async function* () {
          let onAbort: (() => void) | undefined;
          try {
            yield { type: 'message_start' as const, model: 'control-model' };
            await new Promise<void>((resolve, reject) => {
              onAbort = () =>
                reject(
                  new ModelError({
                    code: 'aborted',
                    message: 'Model was aborted.',
                    retryable: false,
                  }),
                );
              if (signal.aborted) onAbort();
              else signal.addEventListener('abort', onAbort, { once: true });
              void gates[input].promise.then(resolve, reject);
            });
            yield { type: 'text_delta' as const, text: `answer:${input}` };
            yield {
              type: 'message_end' as const,
              response: response(`answer:${input}`),
            };
          } finally {
            if (onAbort) signal.removeEventListener('abort', onAbort);
            closed.push(input);
          }
        })();
      }),
      registry(),
      tools,
    );
    const sourceA = source('a', controllers.a.signal);
    const sourceB = source('b', controllers.b.signal);
    const eventsA: AgentLoopEvent[] = [];
    const taskA = (async () => {
      for await (const event of loop.run(sourceA)) eventsA.push(event);
    })();
    const rejectA = assert.rejects(taskA, isAborted);
    const taskB = collect(loop.run(sourceB));
    try {
      await bounded(arrived.promise);
      assert.notEqual(effective.get('a'), effective.get('b'));
      controllers.a.abort();
      await bounded(rejectA);
      assert.equal(effective.get('a')?.aborted, true);
      assert.equal(effective.get('b')?.aborted, false);
      gates.b.resolve();
      const eventsB = await bounded(taskB);
      const end = eventsB.at(-1);
      assert.equal(end?.type, 'loop_end');
      if (end?.type !== 'loop_end') throw new Error();
      assert.equal(end.result.output, 'answer:b');
      assert.deepEqual(end.result.updatedContext?.messages, [
        { role: 'user', content: 'b' },
        { role: 'assistant', content: 'answer:b' },
      ]);
      assert.equal(
        eventsA.some((event) => event.type === 'loop_end'),
        false,
      );
      assert.deepEqual(sourceA.context.messages, []);
      assert.deepEqual(sourceB.context.messages, []);
      assert.deepEqual(closed.sort(), ['a', 'b']);
      assert.equal(getEventListeners(controllers.a.signal, 'abort').length, 0);
      assert.equal(getEventListeners(controllers.b.signal, 'abort').length, 0);
    } finally {
      gates.a.resolve();
      gates.b.resolve();
      controllers.a.abort();
      controllers.b.abort();
      await taskA.catch(() => {});
      await taskB.catch(() => {});
    }
  },
);

test(
  '同一 run 内多工具经过异步屏障仍严格串行，再请求模型前整批结果已回填',
  { timeout: 4000 },
  async () => {
    const calls: ToolCall[] = [
      { id: 'first', name: 'echo', argumentsJson: '{}' },
      { id: 'second', name: 'echo', argumentsJson: '{}' },
    ];
    const gates = [deferred<ToolResult>(), deferred<ToolResult>()];
    const entered = [deferred<void>(), deferred<void>()];
    let active = 0;
    let maximum = 0;
    let modelCalls = 0;
    const order: string[] = [];
    const loop = new DefaultAgentLoop(
      model((request) => {
        modelCalls++;
        if (modelCalls === 1) return completed(response(null, calls));
        assert.deepEqual(
          request.messages
            .filter((message) => message.role === 'tool')
            .map((message) => message.toolCallId),
          ['first', 'second'],
        );
        return completed(response('serial complete'));
      }),
      registry(),
      {
        execute: async (call) => {
          const index = calls.findIndex((value) => value.id === call.id);
          assert.ok(index === 0 || index === 1);
          active++;
          maximum = Math.max(maximum, active);
          order.push(`start:${call.id}`);
          entered[index]!.resolve();
          try {
            return await gates[index]!.promise;
          } finally {
            active--;
            order.push(`end:${call.id}`);
          }
        },
      },
    );
    const task = collect(loop.run(source()));
    try {
      await bounded(entered[0]!.promise);
      assert.deepEqual(order, ['start:first']);
      assert.equal(modelCalls, 1);
      gates[0]!.resolve(success(calls[0]!));
      await bounded(entered[1]!.promise);
      assert.deepEqual(order, ['start:first', 'end:first', 'start:second']);
      assert.equal(modelCalls, 1);
      gates[1]!.resolve(success(calls[1]!));
      const events = await bounded(task);
      assert.equal(events.at(-1)?.type, 'loop_end');
      assert.equal(maximum, 1);
      assert.equal(modelCalls, 2);
      assert.deepEqual(order, [
        'start:first',
        'end:first',
        'start:second',
        'end:second',
      ]);
    } finally {
      gates[0]!.resolve(success(calls[0]!));
      gates[1]!.resolve(success(calls[1]!));
      await task.catch(() => {});
    }
  },
);
