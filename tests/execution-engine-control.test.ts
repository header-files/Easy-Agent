import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
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
const done: IteratorResult<AgentLoopEvent> = { done: true, value: undefined };
const loopEnd: AgentLoopEvent = {
  type: 'loop_end',
  result: { status: 'completed', output: 'complete' },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function observe<T>(pending: Promise<T>): Promise<T> {
  void pending.catch(() => {});
  return pending;
}

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error('Controlled Engine operation did not settle.')),
          1000,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function request(
  loop: AgentLoop,
  executionId: string,
  signal = new AbortController().signal,
): ExecutionRequest {
  return {
    executionId,
    loop,
    context: {
      input: { content: `input:${executionId}` },
      context: { messages: [] },
      config: {},
      control: { signal },
    },
  };
}

async function close(iterator: AsyncIterator<ExecutionEvent>) {
  assert.equal(typeof iterator.return, 'function');
  return iterator.return!();
}

/** next() deliberately ignores cancellation; return() is a separate cleanup acknowledgement. */
function stagedLoop() {
  const entered = deferred<void>();
  const closing = deferred<void>();
  const nextGate = deferred<IteratorResult<AgentLoopEvent>>();
  const closeGate = deferred<IteratorResult<AgentLoopEvent>>();
  const received: AgentLoopContext[] = [];
  let closed = 0;
  const loop: AgentLoop = {
    run(context) {
      received.push(context);
      let reads = 0;
      return {
        [Symbol.asyncIterator]() {
          return {
            next() {
              if (reads++ === 0)
                return Promise.resolve({
                  done: false as const,
                  value: { type: 'loop_start' as const },
                });
              if (reads === 2) {
                entered.resolve();
                return nextGate.promise;
              }
              return Promise.resolve(done);
            },
            return() {
              closed++;
              closing.resolve();
              return closeGate.promise;
            },
          };
        },
      };
    },
  };
  return {
    loop,
    entered,
    closing,
    nextGate,
    closeGate,
    received,
    closeCount: () => closed,
  };
}

async function begin(
  instance: DefaultExecutionEngine,
  value: ExecutionRequest,
) {
  const iterable = instance.execute(value);
  const iterator = iterable[Symbol.asyncIterator]();
  assert.equal((await bounded(iterator.next())).value?.type, 'execution_start');
  const start = await bounded(iterator.next());
  assert.equal(start.value?.type, 'loop_event');
  if (start.value?.type !== 'loop_event') throw new Error();
  assert.equal(start.value.event.type, 'loop_start');
  return iterator;
}

async function collect(
  events: AsyncIterable<ExecutionEvent>,
): Promise<ExecutionEvent[]> {
  const result: ExecutionEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

test(
  'cancel 立即通知但清理确认前保持 RUNNING，重复请求幂等并接管迟到 next 拒绝',
  { timeout: 4000 },
  async () => {
    const instance = new DefaultExecutionEngine({ logger: quiet });
    const external = new AbortController();
    const fixture = stagedLoop();
    assert.equal(instance.cancel('absent'), false);
    const iterator = await begin(
      instance,
      request(fixture.loop, 'cancel', external.signal),
    );
    const pending = observe(iterator.next());
    try {
      await bounded(fixture.entered.promise);
      assert.equal(instance.cancel('cancel'), true);
      assert.equal(instance.cancel('cancel'), true);
      assert.equal(fixture.received[0]?.control.signal.aborted, true);
      assert.equal(external.signal.aborted, false);
      await bounded(fixture.closing.promise);
      assert.equal(instance.getSnapshot('cancel')?.status, 'RUNNING');
      assert.equal(instance.getSnapshot('cancel')?.result, undefined);
      fixture.closeGate.resolve(done);
      const end = await bounded(pending);
      assert.equal(end.value?.type, 'execution_end');
      if (end.value?.type !== 'execution_end') throw new Error();
      assert.equal(end.value.result.status, 'CANCELLED');
      assert.equal(instance.getSnapshot('cancel')?.status, 'CANCELLED');
      assert.equal(instance.cancel('cancel'), false);
      assert.equal(fixture.closeCount(), 1);
      assert.equal(getEventListeners(external.signal, 'abort').length, 0);
      fixture.nextGate.reject(new Error('PRIVATE_LATE_LOOP_REJECTION'));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await iterator.next()).done, true);
    } finally {
      fixture.nextGate.resolve(done);
      fixture.closeGate.resolve(done);
      await bounded(pending).catch(() => {});
      await bounded(close(iterator)).catch(() => {});
    }
  },
);

test(
  '上层 signal 合并取消并等待 Loop 清理，输入对象与私有控制相互独立',
  { timeout: 4000 },
  async () => {
    const instance = new DefaultExecutionEngine({ logger: quiet });
    const external = new AbortController();
    const fixture = stagedLoop();
    const source = request(fixture.loop, 'external', external.signal);
    const iterator = await begin(instance, source);
    const pending = observe(iterator.next());
    try {
      await bounded(fixture.entered.promise);
      const context = fixture.received[0]!;
      assert.notEqual(context, source.context);
      assert.notEqual(context.control.signal, external.signal);
      external.abort(new Error('PRIVATE_ABORT_REASON'));
      await bounded(fixture.closing.promise);
      assert.equal(context.control.signal.aborted, true);
      assert.equal(instance.getSnapshot('external')?.status, 'RUNNING');
      fixture.closeGate.resolve(done);
      const end = await bounded(pending);
      assert.equal(end.value?.type, 'execution_end');
      if (end.value?.type !== 'execution_end') throw new Error();
      assert.equal(end.value.result.status, 'CANCELLED');
      assert.equal(JSON.stringify(end).includes('PRIVATE_ABORT_REASON'), false);
      assert.equal(source.context.control.signal, external.signal);
      assert.equal(source.context.metadata, undefined);
      assert.equal(getEventListeners(external.signal, 'abort').length, 0);
    } finally {
      fixture.nextGate.resolve(done);
      fixture.closeGate.resolve(done);
      await bounded(pending).catch(() => {});
      await bounded(close(iterator)).catch(() => {});
    }
  },
);

test(
  'pending next 时 return 立即请求取消但不假装清理完成，也不向退出者补终止事件',
  { timeout: 4000 },
  async () => {
    const instance = new DefaultExecutionEngine({ logger: quiet });
    const external = new AbortController();
    const fixture = stagedLoop();
    const iterator = await begin(
      instance,
      request(fixture.loop, 'return', external.signal),
    );
    const pending = iterator.next().then(
      (value) => ({ value }),
      (error) => ({ error: error as unknown }),
    );
    let returned = false;
    let shutdown: Promise<IteratorResult<ExecutionEvent>> | undefined;
    try {
      await bounded(fixture.entered.promise);
      shutdown = observe(
        close(iterator).then((value) => {
          returned = true;
          return value;
        }),
      );
      assert.equal(fixture.received[0]?.control.signal.aborted, true);
      await bounded(fixture.closing.promise);
      await Promise.resolve();
      assert.equal(returned, false);
      assert.equal(instance.getSnapshot('return')?.status, 'RUNNING');
      fixture.closeGate.resolve(done);
      assert.equal((await bounded(shutdown)).done, true);
      const waiting = await bounded(pending);
      if ('value' in waiting) assert.equal(waiting.value.done, true);
      assert.equal(instance.getSnapshot('return')?.status, 'CANCELLED');
      assert.equal(external.signal.aborted, false);
      assert.equal(fixture.closeCount(), 1);
      assert.equal(getEventListeners(external.signal, 'abort').length, 0);
    } finally {
      fixture.nextGate.resolve(done);
      fixture.closeGate.resolve(done);
      await pending;
      await bounded(shutdown ?? close(iterator)).catch(() => {});
    }
  },
);

test(
  'for-await break 等待 Loop.return 的协作清理，再维护 CANCELLED 快照',
  { timeout: 4000 },
  async () => {
    const instance = new DefaultExecutionEngine({ logger: quiet });
    const external = new AbortController();
    const fixture = stagedLoop();
    const events: ExecutionEvent[] = [];
    const consuming = observe(
      (async () => {
        for await (const event of instance.execute(
          request(fixture.loop, 'break', external.signal),
        )) {
          events.push(event);
          if (event.type === 'loop_event') break;
        }
      })(),
    );
    try {
      await bounded(fixture.closing.promise);
      assert.equal(fixture.received[0]?.control.signal.aborted, true);
      assert.equal(instance.getSnapshot('break')?.status, 'RUNNING');
      fixture.closeGate.resolve(done);
      await bounded(consuming);
      assert.equal(instance.getSnapshot('break')?.status, 'CANCELLED');
      assert.equal(
        events.some((event) => event.type === 'execution_end'),
        false,
      );
      assert.equal(getEventListeners(external.signal, 'abort').length, 0);
    } finally {
      fixture.nextGate.resolve(done);
      fixture.closeGate.resolve(done);
      await bounded(consuming).catch(() => {});
    }
  },
);

test(
  '没有 return 钩子的 Loop 必须确认真正 EOF，不能把非终止 next 的兑现当作清理完成',
  { timeout: 4000 },
  async () => {
    for (const mode of ['pending_next', 'paused_yield'] as const) {
      const instance = new DefaultExecutionEngine({ logger: quiet });
      const external = new AbortController();
      const nextEntered = deferred<void>();
      const eofEntered = deferred<void>();
      const lateGate = deferred<IteratorResult<AgentLoopEvent>>();
      const eofGate = deferred<IteratorResult<AgentLoopEvent>>();
      let effectiveSignal: AbortSignal | undefined;
      let reads = 0;
      const loop: AgentLoop = {
        run(context) {
          effectiveSignal = context.control.signal;
          return {
            [Symbol.asyncIterator]() {
              return {
                next() {
                  reads++;
                  if (reads === 1)
                    return Promise.resolve({
                      done: false as const,
                      value: { type: 'loop_start' as const },
                    });
                  if (reads === 2) {
                    nextEntered.resolve();
                    return lateGate.promise;
                  }
                  if (reads === 3) {
                    eofEntered.resolve();
                    return eofGate.promise;
                  }
                  throw new Error('Loop was read after EOF.');
                },
              };
            },
          };
        },
      };
      const iterator = await begin(
        instance,
        request(loop, mode, external.signal),
      );
      const pending =
        mode === 'pending_next'
          ? iterator.next().then(
              (value) => ({ value }),
              (error) => ({ error: error as unknown }),
            )
          : undefined;
      let shutdown: Promise<IteratorResult<ExecutionEvent>> | undefined;
      let returned = false;
      try {
        if (pending) await bounded(nextEntered.promise);
        shutdown = observe(
          close(iterator).then((value) => {
            returned = true;
            return value;
          }),
        );
        await bounded(nextEntered.promise);
        assert.equal(effectiveSignal?.aborted, true, mode);
        assert.equal(instance.getSnapshot(mode)?.status, 'RUNNING', mode);
        lateGate.resolve({
          done: false,
          value: {
            type: 'custom_event',
            name: 'cleanup.intermediate',
            data: mode,
          },
        });
        await bounded(eofEntered.promise);
        assert.equal(returned, false, mode);
        assert.equal(reads, 3, mode);
        assert.equal(instance.getSnapshot(mode)?.status, 'RUNNING', mode);
        eofGate.resolve(done);
        assert.equal((await bounded(shutdown)).done, true, mode);
        if (pending) {
          const waiting = await bounded(pending);
          if ('value' in waiting) assert.equal(waiting.value.done, true, mode);
        }
        assert.equal(instance.getSnapshot(mode)?.status, 'CANCELLED', mode);
        assert.equal(external.signal.aborted, false, mode);
        assert.equal(
          getEventListeners(external.signal, 'abort').length,
          0,
          mode,
        );
        assert.equal((await iterator.next()).done, true, mode);
      } finally {
        lateGate.resolve(done);
        eofGate.resolve(done);
        await pending;
        await bounded(shutdown ?? close(iterator)).catch(() => {});
      }
    }
  },
);

test('预取消输入可以开始后直接 CANCELLED，未调用 Loop 且未启动前 cancel 不创建记录', async () => {
  const instance = new DefaultExecutionEngine({ logger: quiet });
  const external = new AbortController();
  external.abort();
  let invoked = 0;
  const loop: AgentLoop = {
    run() {
      invoked++;
      throw new Error('Loop must not run.');
    },
  };
  const iterable = instance.execute(request(loop, 'preabort', external.signal));
  assert.equal(instance.cancel('preabort'), false);
  assert.equal(instance.getSnapshot('preabort'), undefined);
  const events = await collect(iterable);
  assert.deepEqual(
    events.map((event) => event.type),
    ['execution_start', 'execution_end'],
  );
  const end = events.at(-1);
  if (end?.type !== 'execution_end') throw new Error();
  assert.equal(end.result.status, 'CANCELLED');
  assert.equal(invoked, 0);
  assert.equal(instance.cancel('preabort'), false);
  assert.equal(getEventListeners(external.signal, 'abort').length, 0);
});

test(
  '同 Engine 与同 Loop 的两次执行交错，A 等待清理不阻止 B 完成',
  { timeout: 4000 },
  async () => {
    const instance = new DefaultExecutionEngine({ logger: quiet });
    const a = stagedLoop();
    const b = stagedLoop();
    const externalA = new AbortController();
    const externalB = new AbortController();
    const shared: AgentLoop = {
      run(context) {
        const target = context.metadata?.executionId === 'A' ? a : b;
        return target.loop.run(context);
      },
    };
    const iteratorA = await begin(
      instance,
      request(shared, 'A', externalA.signal),
    );
    const iteratorB = await begin(
      instance,
      request(shared, 'B', externalB.signal),
    );
    const pendingA = observe(iteratorA.next());
    const pendingB = observe(iteratorB.next());
    try {
      await bounded(Promise.all([a.entered.promise, b.entered.promise]));
      assert.notEqual(
        a.received[0]?.control.signal,
        b.received[0]?.control.signal,
      );
      assert.equal(instance.cancel('A'), true);
      await bounded(a.closing.promise);
      assert.equal(instance.getSnapshot('A')?.status, 'RUNNING');
      assert.equal(b.received[0]?.control.signal.aborted, false);
      b.nextGate.resolve({ done: false, value: loopEnd });
      assert.equal((await bounded(pendingB)).value?.type, 'loop_event');
      const endB = await bounded(iteratorB.next());
      assert.equal(endB.value?.type, 'execution_end');
      if (endB.value?.type !== 'execution_end') throw new Error();
      assert.equal(endB.value.result.status, 'COMPLETED');
      assert.equal(instance.cancel('B'), false);
      assert.equal(instance.getSnapshot('A')?.status, 'RUNNING');
      a.closeGate.resolve(done);
      const endA = await bounded(pendingA);
      if (endA.value?.type !== 'execution_end') throw new Error();
      assert.equal(endA.value.result.status, 'CANCELLED');
      assert.equal(instance.getSnapshot('B')?.status, 'COMPLETED');
      assert.equal(externalA.signal.aborted, false);
      assert.equal(externalB.signal.aborted, false);
      assert.equal(getEventListeners(externalA.signal, 'abort').length, 0);
      assert.equal(getEventListeners(externalB.signal, 'abort').length, 0);
    } finally {
      a.nextGate.resolve(done);
      a.closeGate.resolve(done);
      b.nextGate.resolve(done);
      b.closeGate.resolve(done);
      await bounded(pendingA).catch(() => {});
      await bounded(pendingB).catch(() => {});
      await bounded(close(iteratorA)).catch(() => {});
      await bounded(close(iteratorB)).catch(() => {});
    }
  },
);

test('同一 Iterable 首次消费前也不能被再次遍历，未启动 return 不注册 Execution', async () => {
  const instance = new DefaultExecutionEngine({ logger: quiet });
  let invoked = 0;
  const loop: AgentLoop = {
    run() {
      invoked++;
      throw new Error('Unused Loop.');
    },
  };
  const iterable = instance.execute(request(loop, 'single'));
  const first = iterable[Symbol.asyncIterator]();
  await assert.rejects(async () => {
    const second = iterable[Symbol.asyncIterator]();
    await second.next();
  });
  assert.equal(instance.getSnapshot('single'), undefined);
  assert.equal((await close(first)).done, true);
  assert.equal(invoked, 0);
  assert.equal(instance.getSnapshot('single'), undefined);
});

test(
  '同一流明确拒绝并发 next，拒绝不破坏原 pending 请求或终态',
  { timeout: 4000 },
  async () => {
    const instance = new DefaultExecutionEngine({ logger: quiet });
    const fixture = stagedLoop();
    const iterator = await begin(
      instance,
      request(fixture.loop, 'concurrent-next'),
    );
    const pending = observe(iterator.next());
    try {
      await bounded(fixture.entered.promise);
      await assert.rejects(
        bounded(iterator.next()),
        (error: unknown) =>
          error instanceof Error && /concurrent/i.test(error.message),
      );
      assert.equal(instance.getSnapshot('concurrent-next')?.status, 'RUNNING');
      fixture.nextGate.resolve({ done: false, value: loopEnd });
      assert.equal((await bounded(pending)).value?.type, 'loop_event');
      const end = await bounded(iterator.next());
      if (end.value?.type !== 'execution_end') throw new Error();
      assert.equal(end.value.result.status, 'COMPLETED');
      assert.equal(fixture.closeCount(), 0);
    } finally {
      fixture.nextGate.resolve(done);
      fixture.closeGate.resolve(done);
      await bounded(pending).catch(() => {});
      await bounded(close(iterator)).catch(() => {});
    }
  },
);

test('execution_end 已提交时 cancel 返回 false，迟到外部 abort 不倒转终态', async () => {
  const instance = new DefaultExecutionEngine({ logger: quiet });
  const external = new AbortController();
  const loop: AgentLoop = {
    async *run() {
      yield { type: 'loop_start' };
      yield loopEnd;
    },
  };
  const iterable = instance.execute(
    request(loop, 'committed', external.signal),
  );
  const iterator = iterable[Symbol.asyncIterator]();
  while (true) {
    const step = await iterator.next();
    assert.equal(step.done, false);
    if (step.value.type === 'execution_end') break;
  }
  const before = instance.getSnapshot('committed');
  assert.equal(before?.status, 'COMPLETED');
  assert.equal(getEventListeners(external.signal, 'abort').length, 0);
  external.abort();
  assert.equal(instance.cancel('committed'), false);
  assert.deepEqual(instance.getSnapshot('committed'), before);
  assert.equal((await iterator.next()).done, true);
});

test(
  '长事件流按消费背压推进，取消监听保持有界并在正常终态释放',
  { timeout: 4000 },
  async () => {
    const instance = new DefaultExecutionEngine({ logger: quiet });
    const external = new AbortController();
    let effectiveSignal: AbortSignal | undefined;
    let reads = 0;
    let maximumListeners = 0;
    const eventCount = 512;
    const loop: AgentLoop = {
      run(context) {
        effectiveSignal = context.control.signal;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next(): Promise<IteratorResult<AgentLoopEvent>> {
                reads++;
                maximumListeners = Math.max(
                  maximumListeners,
                  getEventListeners(context.control.signal, 'abort').length,
                );
                if (reads === 1)
                  return { done: false, value: { type: 'loop_start' } };
                if (reads <= eventCount + 1)
                  return {
                    done: false,
                    value: {
                      type: 'custom_event',
                      name: 'stream.item',
                      data: reads - 2,
                    },
                  };
                if (reads === eventCount + 2)
                  return { done: false, value: loopEnd };
                return done;
              },
              async return() {
                return done;
              },
            };
          },
        };
      },
    };
    const iterable = instance.execute(
      request(loop, 'long-stream', external.signal),
    );
    const iterator = iterable[Symbol.asyncIterator]();
    try {
      assert.equal((await iterator.next()).value?.type, 'execution_start');
      assert.equal(reads, 0);
      const start = await iterator.next();
      if (start.value?.type !== 'loop_event') throw new Error();
      assert.equal(start.value.event.type, 'loop_start');
      for (let index = 0; index < eventCount; index++) {
        const step = await iterator.next();
        if (
          step.value?.type !== 'loop_event' ||
          step.value.event.type !== 'custom_event'
        )
          throw new Error();
        assert.equal(step.value.event.data, index);
        assert.equal(reads, index + 2);
        assert.ok(getEventListeners(external.signal, 'abort').length <= 1);
        if (index === eventCount / 2) {
          const beforePause: number = reads;
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(
            reads,
            beforePause,
            'A paused consumer must not trigger background Loop reads.',
          );
        }
      }
      const lastLoopEvent = await iterator.next();
      if (lastLoopEvent.value?.type !== 'loop_event') throw new Error();
      assert.equal(lastLoopEvent.value.event.type, 'loop_end');
      assert.equal(instance.getSnapshot('long-stream')?.status, 'RUNNING');
      const end = await iterator.next();
      if (end.value?.type !== 'execution_end') throw new Error();
      assert.equal(end.value.result.status, 'COMPLETED');
      assert.equal(reads, eventCount + 3);
      assert.ok(
        maximumListeners <= 2,
        `Cancellation listeners grew to ${maximumListeners}.`,
      );
      assert.ok(effectiveSignal);
      assert.equal(effectiveSignal.aborted, false);
      assert.equal(getEventListeners(effectiveSignal, 'abort').length, 0);
      assert.equal(getEventListeners(external.signal, 'abort').length, 0);
      assert.equal((await iterator.next()).done, true);
    } finally {
      await bounded(close(iterator)).catch(() => {});
    }
  },
);
