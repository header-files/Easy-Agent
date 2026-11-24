import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLogger,
  DefaultAgentManager,
  DefaultExecutionEngine,
  type AgentLoop,
  type ExecutionEvent,
} from '../src/index.ts';

const logger = createLogger({ destination: { write() {} } });

test('Agent与真实Engine整链路复制原生binary view槽，不调用自定义访问器', async () => {
  for (const kind of ['typed-array', 'data-view', 'buffer']) {
    const backing = new ArrayBuffer(8);
    new Uint8Array(backing).set([1, 2, 3, 4], 2);
    const view =
      kind === 'data-view'
        ? new DataView(backing, 2, 4)
        : kind === 'buffer'
          ? Buffer.from(backing, 2, 4)
          : new Uint8Array(backing, 2, 4);
    let reads = 0;
    for (const field of ['buffer', 'byteOffset', 'byteLength', 'length'])
      Object.defineProperty(view, field, {
        enumerable: true,
        configurable: true,
        get() {
          reads++;
          throw new Error('User binary accessor must not run');
        },
      });
    const loop: AgentLoop = {
      async *run(context) {
        yield { type: 'loop_start' };
        yield {
          type: 'loop_end',
          result: {
            status: 'completed',
            output: 'copied',
            updatedContext: context.context,
          },
        };
      },
    };
    const engine = new DefaultExecutionEngine({ logger });
    const session = new DefaultAgentManager(engine, loop, {
      logger,
    }).createSession({ context: { messages: [], data: { view } } });
    const submission = session.submit('input');
    const result = await submission.result;
    assert.equal(result.status, 'COMPLETED', kind);
    const observed: ExecutionEvent[] = [];
    for await (const event of submission.events) observed.push(event);
    assert.equal(observed.at(-1)?.type, 'execution_end', kind);
    const saved = session.getContext().data!.view as typeof view;
    assert.notEqual(saved, view, kind);
    const prototype =
      kind === 'data-view'
        ? DataView.prototype
        : (Object.getPrototypeOf(Uint8Array.prototype) as object);
    const read = (field: string): unknown =>
      Object.getOwnPropertyDescriptor(prototype, field)!.get!.call(saved);
    const buffer = read('buffer') as ArrayBuffer;
    const offset = read('byteOffset') as number;
    const size = read('byteLength') as number;
    assert.equal(offset, 2, kind);
    assert.equal(size, 4, kind);
    const bytes = new Uint8Array(buffer, offset, size);
    assert.deepEqual([...bytes], [1, 2, 3, 4], kind);
    bytes[0] = 99;
    assert.equal(new Uint8Array(backing)[2], 1, kind);
    assert.equal(reads, 0, kind);
  }
});
