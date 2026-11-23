import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLogger,
  DefaultExecutionEngine,
  type AgentLoop,
  type AgentLoopContext,
  type AgentLoopResult,
  type ExecutionEvent,
} from '../src/index.ts';

const logger = createLogger({ destination: { write() {} } });
function context(): AgentLoopContext {
  return {
    input: { content: 'local' },
    context: { messages: [] },
    config: {},
    control: { signal: new AbortController().signal },
  };
}
async function execute(
  engine: DefaultExecutionEngine,
  result: AgentLoopResult,
) {
  const loop: AgentLoop = {
    async *run() {
      yield { type: 'loop_start' };
      yield { type: 'loop_end', result };
    },
  };
  const events: ExecutionEvent[] = [];
  for await (const event of engine.execute({
    executionId: 'snapshot',
    loop,
    context: context(),
  }))
    events.push(event);
  assert.equal(events.at(-1)?.type, 'execution_end');
  return events;
}

test('消息、日期、集合、二进制和循环数据图的多次快照互相隔离，opaque能力保留引用', async () => {
  class Capability {
    #value = 42;
    read() {
      return this.#value;
    }
  }
  const capability = new Capability();
  const callback = () => 42;
  let proxyTraps = 0;
  const proxy = new Proxy(
    { opaque: true },
    {
      getPrototypeOf() {
        proxyTraps++;
        throw new Error('External capability trap');
      },
      ownKeys() {
        proxyTraps++;
        throw new Error('External capability trap');
      },
    },
  );
  const key = Symbol('metadata');
  const nested = { count: 1 };
  const bytes = new Uint8Array([1, 2, 3]);
  let accessorReads = 0;
  const data = {
    nested,
    list: [nested],
    map: new Map([['nested', nested]]),
    set: new Set([nested]),
    date: new Date('2026-11-23T00:00:00.000Z'),
    regexp: /sample/g,
    bytes,
    buffer: bytes.buffer,
    bigint: 7n,
    missing: undefined,
    notFinite: NaN,
    [key]: { original: true },
    callback,
    capability,
    proxy,
    self: undefined as unknown,
  };
  data.self = data;
  data.regexp.lastIndex = 2;
  Object.defineProperty(data, 'externalAccessor', {
    enumerable: true,
    get() {
      accessorReads++;
      return capability;
    },
  });
  const result: AgentLoopResult = {
    status: 'completed',
    output: 'authoritative',
    updatedContext: {
      messages: [{ role: 'assistant', content: 'authoritative' }],
      data,
    },
    details: { sameData: data },
  };
  const engine = new DefaultExecutionEngine({ logger });
  const events = await execute(engine, result);
  const resultAt = () => {
    const current = engine.getSnapshot('snapshot')?.result;
    if (current?.status !== 'COMPLETED')
      throw new Error('Missing completed snapshot');
    return current.loopResult;
  };
  const first = resultAt();
  const firstData = first.updatedContext!.data as typeof data;
  assert.notEqual(firstData, data);
  assert.equal(firstData.self, firstData);
  assert.equal(firstData.list[0], firstData.nested);
  assert.equal(firstData.map.get('nested'), firstData.nested);
  assert.equal([...firstData.set][0], firstData.nested);
  assert.equal(firstData.bytes.buffer, firstData.buffer);
  assert.equal(first.details?.sameData, firstData);
  assert.equal(firstData.callback, callback);
  assert.equal(firstData.capability, capability);
  assert.equal(firstData.proxy, proxy);
  assert.equal(firstData.capability.read(), 42);
  assert.equal(firstData.bigint, 7n);
  assert.equal(Object.hasOwn(firstData, 'missing'), true);
  assert.equal(firstData.missing, undefined);
  assert.ok(Number.isNaN(firstData.notFinite));
  assert.deepEqual(firstData[key], { original: true });
  assert.equal(firstData.regexp.lastIndex, 2);
  assert.equal(accessorReads, 0);
  assert.equal(proxyTraps, 0);
  firstData.nested.count = 99;
  firstData.list.push({ count: 2 });
  firstData.map.set('other', { count: 3 });
  firstData.set.clear();
  firstData.date.setUTCFullYear(2000);
  firstData.bytes[0] = 99;
  firstData.regexp.lastIndex = 0;
  firstData[key].original = false;
  first.updatedContext!.messages[0]!.content = 'snapshot mutation';
  first.output = 'snapshot mutation';
  const terminal = events.at(-1);
  if (
    terminal?.type !== 'execution_end' ||
    terminal.result.status !== 'COMPLETED'
  )
    throw new Error();
  terminal.result.loopResult.output = 'event mutation';
  data.nested.count = 88;
  result.output = 'source mutation';
  const second = resultAt();
  const secondData = second.updatedContext!.data as typeof data;
  assert.equal(second.output, 'authoritative');
  assert.equal(second.updatedContext?.messages[0]?.content, 'authoritative');
  assert.equal(secondData.nested.count, 1);
  assert.equal(secondData.list.length, 1);
  assert.equal(secondData.map.size, 1);
  assert.equal(secondData.set.size, 1);
  assert.equal(secondData.date.toISOString(), '2026-11-23T00:00:00.000Z');
  assert.deepEqual([...secondData.bytes], [1, 2, 3]);
  assert.equal(secondData.regexp.lastIndex, 2);
  assert.deepEqual(secondData[key], { original: true });
  assert.equal(secondData.self, secondData);
  assert.equal(accessorReads, 0);
  assert.equal(proxyTraps, 0);
});

test('typed view和backing buffer互相引用时，快照仍保持同一数据图中的别名关系', async () => {
  const buffer = new ArrayBuffer(4) as ArrayBuffer & { view?: Uint8Array };
  const view = new Uint8Array(buffer);
  view[0] = 7;
  buffer.view = view;
  const engine = new DefaultExecutionEngine({ logger });
  await execute(engine, {
    status: 'completed',
    output: 'done',
    details: { view, buffer },
  });
  const result = engine.getSnapshot('snapshot')?.result;
  if (result?.status !== 'COMPLETED')
    throw new Error('Missing completed snapshot');
  const copied = result.loopResult.details as {
    view: Uint8Array;
    buffer: typeof buffer;
  };
  assert.notEqual(copied.view, view);
  assert.notEqual(copied.buffer, buffer);
  assert.equal(copied.view.buffer, copied.buffer);
  assert.equal(copied.buffer.view, copied.view);
  assert.equal(copied.view[0], 7);
  copied.view[0] = 99;
  assert.equal(view[0], 7);
});

test('Loop结束事件到EOF期间的外部修改不能改变已验证结果', async () => {
  const source: AgentLoopResult = {
    status: 'completed',
    output: 'original',
    details: { nested: { value: 1 } },
  };
  const loop: AgentLoop = {
    async *run() {
      yield { type: 'loop_start' };
      yield { type: 'loop_end', result: source };
      source.output = 'Loop mutation';
      (source.details!.nested as { value: number }).value = 99;
    },
  };
  const engine = new DefaultExecutionEngine({ logger });
  let final: ExecutionEvent | undefined;
  for await (const event of engine.execute({
    executionId: 'immutable-end',
    loop,
    context: context(),
  })) {
    if (event.type === 'loop_event' && event.event.type === 'loop_end') {
      event.event.result.output = 'consumer mutation';
      (event.event.result.details!.nested as { value: number }).value = 88;
    }
    final = event;
  }
  assert.equal(final?.type, 'execution_end');
  if (final?.type !== 'execution_end' || final.result.status !== 'COMPLETED')
    throw new Error();
  assert.equal(final.result.loopResult.output, 'original');
  assert.deepEqual(final.result.loopResult.details, { nested: { value: 1 } });
  assert.deepEqual(engine.getSnapshot('immutable-end')?.result, final.result);
});

test('LoopResult已验证的status和output读取一次后物化，对外事件与终态保持一致', async () => {
  let statusReads = 0;
  let outputReads = 0;
  const result = {
    get status() {
      statusReads++;
      return statusReads === 1 ? 'completed' : 'stopped';
    },
    get output() {
      outputReads++;
      return outputReads === 1 ? 'verified' : 42;
    },
  } as unknown as AgentLoopResult;
  const engine = new DefaultExecutionEngine({ logger });
  const events = await execute(engine, result);
  const forwarded = events.find(
    (event) => event.type === 'loop_event' && event.event.type === 'loop_end',
  );
  if (forwarded?.type !== 'loop_event' || forwarded.event.type !== 'loop_end')
    throw new Error();
  assert.deepEqual(forwarded.event.result, {
    status: 'completed',
    output: 'verified',
  });
  const final = events.at(-1);
  if (final?.type !== 'execution_end' || final.result.status !== 'COMPLETED')
    throw new Error();
  assert.deepEqual(final.result.loopResult, forwarded.event.result);
  assert.deepEqual(engine.getSnapshot('snapshot')?.result, final.result);
  assert.equal(statusReads, 1);
  assert.equal(outputReads, 1);
});
