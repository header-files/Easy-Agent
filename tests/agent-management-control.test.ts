import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionExecution } from '../src/harness/contracts/agent/index.ts';
import type {
  AgentLoop,
  AgentLoopContext,
} from '../src/harness/contracts/agent-loop/index.ts';
import type {
  ExecutionEngine,
  ExecutionEvent,
  ExecutionRequest,
  ExecutionResult,
} from '../src/harness/contracts/execution/index.ts';
import type { Logger } from '../src/runtime/logging/index.ts';
import {
  DefaultAgentManager,
  SessionEventBufferOverflowError,
} from '../src/agent/index.ts';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function observe<T>(promise: Promise<T>): Promise<T> {
  void promise.catch(() => {});
  return promise;
}

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Controlled Agent operation did not settle.')),
          1000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function updated(context: AgentLoopContext): AgentLoopContext['context'] {
  return {
    messages: [
      ...context.context.messages,
      { role: 'user', content: context.input.content },
      { role: 'assistant', content: `answer:${context.input.content}` },
    ],
  };
}

/** Separate work and cleanup gates make cancellation acknowledgement observable. */
function gatedLoop() {
  const entries = new Map<
    string,
    {
      work: ReturnType<typeof deferred<void>>;
      cleanup: ReturnType<typeof deferred<void>>;
      started: ReturnType<typeof deferred<AgentLoopContext>>;
      cleaning: ReturnType<typeof deferred<void>>;
      starts: number;
    }
  >();
  const entry = (input: string) => {
    let value = entries.get(input);
    if (!value) {
      value = {
        work: deferred<void>(),
        cleanup: deferred<void>(),
        started: deferred<AgentLoopContext>(),
        cleaning: deferred<void>(),
        starts: 0,
      };
      entries.set(input, value);
    }
    return value;
  };
  const order: string[] = [];
  let active = 0;
  let maximum = 0;
  const loop: AgentLoop = {
    async *run(context) {
      const current = entry(context.input.content);
      const signal = context.control.signal;
      const cancel = () => current.work.resolve();
      current.starts++;
      order.push(context.input.content);
      active++;
      maximum = Math.max(maximum, active);
      current.started.resolve(context);
      signal.addEventListener('abort', cancel, { once: true });
      try {
        yield { type: 'loop_start' };
        if (signal.aborted) current.work.resolve();
        await current.work.promise;
        if (signal.aborted) {
          throw new Error('Controlled Loop was cancelled.');
        }
        yield {
          type: 'loop_end',
          result: {
            status: 'completed',
            output: `answer:${context.input.content}`,
            updatedContext: updated(context),
          },
        };
      } finally {
        if (signal.aborted) {
          current.cleaning.resolve();
          await current.cleanup.promise;
        }
        signal.removeEventListener('abort', cancel);
        active--;
      }
    },
  };
  return {
    loop,
    entry,
    order,
    maximum: () => maximum,
    releaseAll() {
      for (const value of entries.values()) {
        value.work.resolve();
        value.cleanup.resolve();
      }
    },
  };
}

function manager(loop: AgentLoop, capacity = 64) {
  return new DefaultAgentManager(
    new DefaultExecutionEngine({ logger: quiet }),
    loop,
    { logger: quiet, eventBufferCapacity: capacity },
  );
}

async function collect(
  events: AsyncIterable<ExecutionEvent>,
): Promise<ExecutionEvent[]> {
  const result: ExecutionEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

async function close(iterator: AsyncIterator<ExecutionEvent>) {
  assert.equal(typeof iterator.return, 'function');
  return iterator.return!();
}

async function settled(handles: SessionExecution[]): Promise<void> {
  await Promise.all(
    handles.map((handle) => bounded(handle.result).catch(() => {})),
  );
}

test(
  '运行 A 时排队取消 B 立即结算且无 Engine 事件，剩余 C 按 FIFO 继续',
  { timeout: 4000 },
  async () => {
    const fixture = gatedLoop();
    const instance = manager(fixture.loop);
    const session = instance.createSession();
    const a = fixture.entry('A');
    const b = fixture.entry('B');
    const c = fixture.entry('C');
    const handles = [
      session.submit('A'),
      session.submit('B'),
      session.submit('C'),
    ];
    try {
      await bounded(a.started.promise);
      assert.equal(instance.listSessions()[0]?.queuedCount, 2);
      assert.equal(session.cancel(handles[1]!.executionId), true);
      assert.deepEqual(await bounded(handles[1]!.result), {
        status: 'CANCELLED',
        reason: 'cancelled_while_queued',
      });
      assert.deepEqual(await bounded(collect(handles[1]!.events)), []);
      assert.equal(b.starts, 0);
      assert.equal(session.cancel(handles[1]!.executionId), false);
      a.work.resolve();
      assert.equal((await bounded(handles[0]!.result)).status, 'COMPLETED');
      await bounded(c.started.promise);
      assert.deepEqual(fixture.order, ['A', 'C']);
      c.work.resolve();
      assert.equal((await bounded(handles[2]!.result)).status, 'COMPLETED');
      assert.equal(fixture.maximum(), 1);
    } finally {
      fixture.releaseAll();
      await settled(handles);
    }
  },
);

test(
  '运行取消等待 Engine/Loop 清理后结算，未收尾不能启动同 Session 下一项',
  { timeout: 4000 },
  async () => {
    const fixture = gatedLoop();
    const instance = manager(fixture.loop);
    const session = instance.createSession();
    const a = fixture.entry('A');
    const b = fixture.entry('B');
    const first = session.submit('A');
    const next = session.submit('B');
    let firstSettled = false;
    void first.result.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      },
    );
    try {
      const context = await bounded(a.started.promise);
      assert.equal(session.cancel(first.executionId), true);
      assert.equal(session.cancel(first.executionId), true);
      await bounded(a.cleaning.promise);
      assert.equal(context.control.signal.aborted, true);
      assert.equal(firstSettled, false);
      assert.equal(b.starts, 0);
      assert.equal(await instance.deleteSession(session.sessionId), false);
      a.cleanup.resolve();
      assert.equal((await bounded(first.result)).status, 'CANCELLED');
      assert.equal(session.cancel(first.executionId), false);
      await bounded(b.started.promise);
      b.work.resolve();
      assert.equal((await bounded(next.result)).status, 'COMPLETED');
      assert.equal(fixture.maximum(), 1);
    } finally {
      fixture.releaseAll();
      await settled([first, next]);
    }
  },
);

test(
  'Engine 惰性启动窗口 cancel 返回 false 仍凭提交 signal 受理取消，不漏启动竞态',
  { timeout: 4000 },
  async () => {
    const captured = deferred<ExecutionRequest>();
    const startup = deferred<void>();
    let requests = 0;
    const engine: ExecutionEngine = {
      execute(request) {
        requests++;
        captured.resolve(request);
        return {
          async *[Symbol.asyncIterator]() {
            await startup.promise;
            yield {
              type: 'execution_start',
              executionId: request.executionId,
              timestamp: '2026-11-24T00:00:00.000Z',
            };
            const result: ExecutionResult = request.context.control.signal
              .aborted
              ? { status: 'CANCELLED', reason: 'Execution was cancelled.' }
              : {
                  status: 'COMPLETED',
                  loopResult: { status: 'completed', output: 'unexpected' },
                };
            yield {
              type: 'execution_end',
              executionId: request.executionId,
              timestamp: '2026-11-24T00:00:01.000Z',
              result,
            };
          },
        };
      },
      cancel: () => false,
      getSnapshot: () => undefined,
    };
    const unused: AgentLoop = {
      run() {
        throw new Error('Stub Engine does not invoke Loop.');
      },
    };
    const session = new DefaultAgentManager(engine, unused, {
      logger: quiet,
    }).createSession();
    const handle = session.submit('cancel during startup');
    let resolved = false;
    void handle.result.then(
      () => {
        resolved = true;
      },
      () => {
        resolved = true;
      },
    );
    try {
      const request = await bounded(captured.promise);
      assert.equal(session.cancel(handle.executionId), true);
      assert.equal(request.context.control.signal.aborted, true);
      assert.equal(resolved, false);
      startup.resolve();
      assert.equal((await bounded(handle.result)).status, 'CANCELLED');
      assert.equal(requests, 1);
      assert.equal(session.cancel(handle.executionId), false);
    } finally {
      startup.resolve();
      await settled([handle]);
    }
  },
);

test(
  '不同 Session 真正并发，取消一项或错误 Session 的 ID 不影响另一项',
  { timeout: 4000 },
  async () => {
    const fixture = gatedLoop();
    const instance = manager(fixture.loop);
    const sessionA = instance.createSession();
    const sessionB = instance.createSession();
    const a = fixture.entry('A');
    const b = fixture.entry('B');
    const handleA = sessionA.submit('A');
    const handleB = sessionB.submit('B');
    try {
      const [contextA, contextB] = await bounded(
        Promise.all([a.started.promise, b.started.promise]),
      );
      assert.equal(fixture.maximum(), 2);
      assert.notEqual(contextA.control.signal, contextB.control.signal);
      assert.equal(sessionA.cancel(handleB.executionId), false);
      assert.equal(sessionA.cancel(handleA.executionId), true);
      await bounded(a.cleaning.promise);
      assert.equal(contextB.control.signal.aborted, false);
      b.work.resolve();
      assert.equal((await bounded(handleB.result)).status, 'COMPLETED');
      assert.equal(sessionB.cancel(handleB.executionId), false);
      a.cleanup.resolve();
      assert.equal((await bounded(handleA.result)).status, 'CANCELLED');
      assert.deepEqual(sessionA.getContext().messages, []);
      assert.equal(sessionB.getContext().messages.at(-1)?.content, 'answer:B');
    } finally {
      fixture.releaseAll();
      await settled([handleA, handleB]);
    }
  },
);

test(
  'observer break 或 pending next 后 return 仅关闭观察，不取消底层 Execution',
  { timeout: 4000 },
  async () => {
    for (const mode of ['break', 'pending_return'] as const) {
      const fixture = gatedLoop();
      const entry = fixture.entry(mode);
      const session = manager(fixture.loop).createSession();
      const handle = session.submit(mode);
      try {
        const context = await bounded(entry.started.promise);
        if (mode === 'break') {
          for await (const event of handle.events) {
            assert.equal(event.type, 'execution_start');
            break;
          }
        } else {
          const iterator = handle.events[Symbol.asyncIterator]();
          assert.equal(
            (await bounded(iterator.next())).value?.type,
            'execution_start',
          );
          assert.equal(
            (await bounded(iterator.next())).value?.type,
            'loop_event',
          );
          const pending = observe(iterator.next());
          assert.equal((await bounded(close(iterator))).done, true);
          assert.equal((await bounded(pending)).done, true);
        }
        assert.equal(context.control.signal.aborted, false);
        assert.equal(entry.starts, 1);
        entry.work.resolve();
        assert.equal((await bounded(handle.result)).status, 'COMPLETED');
        assert.equal(
          session.getContext().messages.at(-1)?.content,
          `answer:${mode}`,
        );
      } finally {
        fixture.releaseAll();
        await settled([handle]);
      }
    }
  },
);

test(
  '事件缓冲溢出仅使观察流失败，result 和上下文提交及后续 FIFO 不受影响',
  { timeout: 4000 },
  async () => {
    const order: string[] = [];
    const loop: AgentLoop = {
      async *run(context) {
        order.push(context.input.content);
        yield { type: 'loop_start' };
        for (let index = 0; index < 16; index++)
          yield { type: 'custom_event', name: 'burst', data: index };
        yield {
          type: 'loop_end',
          result: {
            status: 'completed',
            output: context.input.content,
            updatedContext: updated(context),
          },
        };
      },
    };
    const session = manager(loop, 3).createSession();
    const first = session.submit('first');
    const second = session.submit('second');
    const results = await bounded(Promise.all([first.result, second.result]));
    assert.deepEqual(
      results.map((result) => result.status),
      ['COMPLETED', 'COMPLETED'],
    );
    assert.deepEqual(order, ['first', 'second']);
    assert.deepEqual(
      session
        .getContext()
        .messages.filter((message) => message.role === 'user')
        .map((message) => message.content),
      ['first', 'second'],
    );
    for (const handle of [first, second]) {
      await assert.rejects(
        collect(handle.events),
        (error: unknown) => error instanceof SessionEventBufferOverflowError,
      );
      assert.equal((await handle.result).status, 'COMPLETED');
    }
  },
);

test('未溢出的缓存可以在 result 完成后晚读，顺序与 Engine 终态结果保持一致', async () => {
  const loop: AgentLoop = {
    async *run(context) {
      yield { type: 'loop_start' };
      yield { type: 'output_delta', content: context.input.content };
      yield {
        type: 'loop_end',
        result: { status: 'completed', output: context.input.content },
      };
    },
  };
  const session = manager(loop).createSession();
  const handle = session.submit('late observer');
  const result = await bounded(handle.result);
  const events = await bounded(collect(handle.events));
  assert.deepEqual(
    events.map((event) =>
      event.type === 'loop_event' ? event.event.type : event.type,
    ),
    [
      'execution_start',
      'loop_start',
      'output_delta',
      'loop_end',
      'execution_end',
    ],
  );
  const last = events.at(-1);
  if (last?.type !== 'execution_end') throw new Error();
  assert.deepEqual(last.result, result);
  assert.equal(session.cancel(handle.executionId), false);
});

test(
  '观察流只允许一次遍历，拒绝并发 reader 时不破坏已有 pending next',
  { timeout: 4000 },
  async () => {
    const fixture = gatedLoop();
    const entry = fixture.entry('readers');
    const handle = manager(fixture.loop).createSession().submit('readers');
    const iterator = handle.events[Symbol.asyncIterator]();
    try {
      await bounded(entry.started.promise);
      await assert.rejects(async () => {
        const second = handle.events[Symbol.asyncIterator]();
        await second.next();
      });
      assert.equal(
        (await bounded(iterator.next())).value?.type,
        'execution_start',
      );
      assert.equal((await bounded(iterator.next())).value?.type, 'loop_event');
      const pending = observe(iterator.next());
      await assert.rejects(
        bounded(iterator.next()),
        (error: unknown) =>
          error instanceof Error && /concurrent/i.test(error.message),
      );
      entry.work.resolve();
      const resumed = await bounded(pending);
      if (resumed.value?.type !== 'loop_event') throw new Error();
      assert.equal(resumed.value.event.type, 'loop_end');
      assert.equal(
        (await bounded(iterator.next())).value?.type,
        'execution_end',
      );
      assert.equal((await bounded(iterator.next())).done, true);
      assert.equal((await bounded(handle.result)).status, 'COMPLETED');
      assert.equal(entry.starts, 1);
    } finally {
      fixture.releaseAll();
      await settled([handle]);
      await bounded(close(iterator)).catch(() => {});
    }
  },
);

test('submit 后在调度微任务前取消，立即返回 queued 结果而不调用 Engine', async () => {
  let invoked = 0;
  const engine: ExecutionEngine = {
    execute() {
      invoked++;
      throw new Error('Queued cancellation must not call Engine.');
    },
    cancel: () => false,
    getSnapshot: () => undefined,
  };
  const loop: AgentLoop = {
    run() {
      throw new Error('Unused Loop.');
    },
  };
  const instance = new DefaultAgentManager(engine, loop, { logger: quiet });
  const session = instance.createSession();
  const handle = session.submit('cancel immediately');
  assert.equal(session.cancel(handle.executionId), true);
  assert.deepEqual(await bounded(handle.result), {
    status: 'CANCELLED',
    reason: 'cancelled_while_queued',
  });
  assert.deepEqual(await bounded(collect(handle.events)), []);
  assert.equal(invoked, 0);
  assert.equal(await instance.deleteSession(session.sessionId), true);
  assert.throws(() => session.submit('after deletion'), /closed/i);
});
