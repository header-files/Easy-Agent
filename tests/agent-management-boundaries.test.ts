import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLogger,
  DefaultAgentManager,
  type AgentLoop,
  type ExecutionEngine,
  type ExecutionEvent,
  type ExecutionRequest,
  type ExecutionResult,
} from '../src/index.ts';

const logger = createLogger({ destination: { write() {} } });
const loop: AgentLoop = {
  async *run() {
    yield { type: 'loop_start' };
    yield {
      type: 'loop_end',
      result: { status: 'completed', output: 'unused' },
    };
  },
};
const timestamp = '2026-11-24T00:00:00.000Z';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function success(content = 'committed'): ExecutionResult {
  return {
    status: 'COMPLETED',
    loopResult: {
      status: 'completed',
      output: content,
      updatedContext: { messages: [{ role: 'assistant', content }] },
    },
  };
}
function events(
  request: ExecutionRequest,
  result = success(),
): ExecutionEvent[] {
  const executionId = request.executionId;
  return [
    { type: 'execution_start', executionId, timestamp },
    { type: 'loop_event', executionId, event: { type: 'loop_start' } },
    ...(result.status === 'COMPLETED'
      ? [
          {
            type: 'loop_event' as const,
            executionId,
            event: { type: 'loop_end' as const, result: result.loopResult },
          },
        ]
      : []),
    { type: 'execution_end', executionId, timestamp, result },
  ];
}
function engine(execute: ExecutionEngine['execute']): ExecutionEngine {
  return { execute, cancel: () => false, getSnapshot: () => undefined };
}
async function collect(source: AsyncIterable<ExecutionEvent>) {
  const result: ExecutionEvent[] = [];
  for await (const event of source) result.push(event);
  return result;
}
async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_yes, no) => {
        timer = setTimeout(() => no(new Error('Result did not settle')), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  'Engine异常、缺失或重复终态、错ID等均安全FAILED且不污染后续FIFO任务',
  { timeout: 5000 },
  async () => {
    for (const mode of [
      'throw',
      'next-reject',
      'empty',
      'missing-end',
      'duplicate-end',
      'after-end',
      'wrong-id',
      'early-end',
      'bad-result',
      'non-iterable',
    ]) {
      const started: string[] = [];
      const instance = new DefaultAgentManager(
        engine((request) => {
          const input = request.context.input.content;
          started.push(input);
          if (input === 'B') {
            assert.deepEqual(request.context.context.messages, []);
            return (async function* () {
              yield* events(request, success('B'));
            })();
          }
          if (mode === 'throw') throw new Error('private Engine secret');
          if (mode === 'non-iterable') return null as never;
          return (async function* () {
            const normal = events(request, success('must not commit'));
            switch (mode) {
              case 'next-reject':
                yield normal[0]!;
                throw new Error('private Engine secret');
              case 'empty':
                return;
              case 'missing-end':
                yield* normal.slice(0, -1);
                return;
              case 'duplicate-end':
                yield* normal;
                yield normal.at(-1)!;
                return;
              case 'after-end':
                yield* normal;
                yield normal[1]!;
                return;
              case 'wrong-id':
                yield { ...normal[0]!, executionId: 'other-session-execution' };
                return;
              case 'early-end':
                yield normal.at(-1)!;
                return;
              case 'bad-result':
                yield* normal.slice(0, -1);
                yield {
                  type: 'execution_end',
                  executionId: request.executionId,
                  timestamp,
                  result: {
                    status: 'COMPLETED',
                    loopResult: {
                      status: 'completed',
                      output: 'bad',
                      updatedContext: { messages: [42] },
                    },
                  } as never,
                };
                return;
            }
          })();
        }),
        loop,
        { logger },
      );
      const session = instance.createSession();
      const a = session.submit('A');
      const b = session.submit('B');
      const [first, second] = await bounded(Promise.all([a.result, b.result]));
      assert.equal(first.status, 'FAILED', mode);
      if (first.status !== 'FAILED') throw new Error(mode);
      assert.equal(first.error.code, 'internal_error', mode);
      assert.equal(
        JSON.stringify(first).includes('private Engine secret'),
        false,
        mode,
      );
      assert.equal(second.status, 'COMPLETED', mode);
      assert.deepEqual(started, ['A', 'B'], mode);
      assert.deepEqual(
        session.getContext().messages,
        [{ role: 'assistant', content: 'B' }],
        mode,
      );
      const observed = await collect(a.events);
      const terminal = observed.filter(
        (event) => event.type === 'execution_end',
      );
      assert.ok(terminal.length <= 1, mode);
      assert.ok(
        terminal.every((event) => event.result.status === 'COMPLETED'),
        'Agent must not forge a FAILED Engine event',
      );
      assert.equal(session.cancel(a.executionId), false, mode);
    }
  },
);

test(
  '必须等待Engine终态之后的EOF，先commit再结算result和启动下一项',
  { timeout: 4000 },
  async () => {
    for (const failAfterEnd of [false, true]) {
      const afterEnd = deferred<void>();
      const release = deferred<void>();
      const inputs: string[] = [];
      const instance = new DefaultAgentManager(
        engine((request) =>
          (async function* () {
            const input = request.context.input.content;
            inputs.push(input);
            if (input === 'B')
              assert.deepEqual(
                request.context.context.messages,
                failAfterEnd ? [] : [{ role: 'assistant', content: 'A' }],
              );
            yield* events(request, success(input));
            if (input === 'A') {
              afterEnd.resolve();
              await release.promise;
              if (failAfterEnd)
                throw new Error('private failure after terminal event');
            }
          })(),
        ),
        loop,
        { logger },
      );
      const session = instance.createSession();
      const a = session.submit('A');
      const b = session.submit('B');
      let settled = false;
      void a.result.then(() => {
        settled = true;
      });
      try {
        await afterEnd.promise;
        assert.equal(settled, false);
        assert.deepEqual(session.getContext().messages, []);
        assert.deepEqual(inputs, ['A']);
        assert.equal(await instance.deleteSession(session.sessionId), false);
        release.resolve();
        assert.equal(
          (await a.result).status,
          failAfterEnd ? 'FAILED' : 'COMPLETED',
        );
        assert.equal((await b.result).status, 'COMPLETED');
        assert.deepEqual(session.getContext().messages, [
          { role: 'assistant', content: 'B' },
        ]);
      } finally {
        release.resolve();
        await Promise.all([a.result, b.result]);
      }
    }
  },
);

test(
  '错误Engine流仍等待协作式return完成，不能为兑现result提前放行同Session队列',
  { timeout: 4000 },
  async () => {
    const closing = deferred<void>();
    const release = deferred<IteratorResult<ExecutionEvent>>();
    const inputs: string[] = [];
    let next = 0;
    let closeCalls = 0;
    let requestSignal: AbortSignal | undefined;
    const instance = new DefaultAgentManager(
      engine((request) => {
        inputs.push(request.context.input.content);
        if (request.context.input.content === 'B')
          return (async function* () {
            yield* events(request, success('B'));
          })();
        requestSignal = request.context.control.signal;
        return {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                next++;
                return {
                  done: false as const,
                  value:
                    next === 1
                      ? events(request)[0]!
                      : {
                          type: 'loop_event' as const,
                          executionId: 'wrong',
                          event: { type: 'loop_start' as const },
                        },
                };
              },
              return() {
                closeCalls++;
                closing.resolve();
                return release.promise;
              },
            };
          },
        };
      }),
      loop,
      { logger },
    );
    const session = instance.createSession();
    const a = session.submit('A');
    const b = session.submit('B');
    let settled = false;
    void a.result.then(() => {
      settled = true;
    });
    try {
      await closing.promise;
      assert.equal(requestSignal?.aborted, true);
      assert.equal(settled, false);
      assert.deepEqual(inputs, ['A']);
      assert.equal(
        instance.listSessions()[0]?.runningExecutionId,
        a.executionId,
      );
      assert.equal(await instance.deleteSession(session.sessionId), false);
      release.resolve({ done: true, value: undefined });
      assert.equal((await a.result).status, 'FAILED');
      assert.equal((await b.result).status, 'COMPLETED');
      assert.equal(closeCalls, 1);
    } finally {
      release.resolve({ done: true, value: undefined });
      await Promise.all([a.result, b.result]);
    }
  },
);

test(
  'ExecutionResult根then不能接管结果Promise，嵌套data中的能力值仍保留',
  { timeout: 5000 },
  async () => {
    for (const mode of ['reject', 'never', 'getter']) {
      let rootTouches = 0;
      const nestedThen = () => {
        throw new Error('Nested capability must not be invoked');
      };
      const result = success();
      if (result.status !== 'COMPLETED') throw new Error();
      result.loopResult.updatedContext!.data = {
        then: nestedThen,
        original: true,
      };
      Object.defineProperty(result, 'then', {
        enumerable: true,
        get() {
          rootTouches++;
          if (mode === 'getter') throw new Error('private thenable getter');
          return (_yes: unknown, no: (error: Error) => void) => {
            if (mode === 'reject') no(new Error('private thenable rejection'));
          };
        },
      });
      const instance = new DefaultAgentManager(
        engine((request) =>
          (async function* () {
            yield* events(request, result);
          })(),
        ),
        loop,
        { logger },
      );
      const session = instance.createSession();
      const submission = session.submit('input');
      const final = await bounded(submission.result);
      assert.equal(final.status, 'COMPLETED', mode);
      assert.equal(Object.hasOwn(final, 'then'), false, mode);
      assert.equal(rootTouches, 0, mode);
      assert.equal(session.getContext().data!.then, nestedThen, mode);
    }
  },
);
