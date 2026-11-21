import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ToolExecutionError,
  type ToolCall,
  type ToolHandler,
  type ToolSpec,
} from '../src/harness/contracts/tool/index.ts';
import type { Logger } from '../src/runtime/logging/index.ts';
import {
  DefaultToolExecutor,
  DefaultToolRegistry,
  toModelToolDefinition,
  toToolResultMessage,
} from '../src/runtime/tool/index.ts';

const quiet: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return quiet;
  },
};
const spec = (): ToolSpec => ({
  name: 'echo',
  description: 'Echo a string',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
});
const call = (argumentsJson = '{"text":"hello"}'): ToolCall => ({
  id: 'call-1',
  name: 'echo',
  argumentsJson,
});
function setup(
  handler: ToolHandler = (args) => ({ content: String(args.text) }),
) {
  const registry = new DefaultToolRegistry();
  registry.register(spec(), handler);
  return {
    registry,
    executor: new DefaultToolExecutor(registry, { logger: quiet }),
  };
}

test('Registry注册、列举、查询、注销、重复拒绝及重注册', () => {
  const { registry } = setup();
  assert.equal(registry.get('echo')?.spec.description, 'Echo a string');
  assert.deepEqual(
    registry.list().map((item) => item.name),
    ['echo'],
  );
  assert.throws(
    () => registry.register(spec(), () => ({ content: 'different' })),
    /already registered/,
  );
  assert.equal(registry.unregister('missing'), false);
  assert.equal(registry.unregister('echo'), true);
  assert.equal(registry.get('echo'), undefined);
  assert.deepEqual(registry.list(), []);
  registry.register(spec(), () => ({ content: 'replacement' }));
  assert.equal(registry.list().length, 1);
});

test('注册输入和get/list返回值均为防御性深拷贝', async () => {
  const declaration = spec();
  const registry = new DefaultToolRegistry();
  registry.register(declaration, (args) => ({ content: String(args.text) }));
  declaration.name = 'mutated';
  declaration.parameters.required = ['other'];
  const returned = registry.get('echo')!;
  returned.spec.name = 'returned-change';
  returned.spec.parameters.additionalProperties = true;
  const listed = registry.list();
  listed[0]!.parameters.required = ['other'];
  assert.deepEqual(registry.get('echo')?.spec, spec());
  const executor = new DefaultToolExecutor(registry, { logger: quiet });
  assert.equal((await executor.execute(call())).status, 'success');
  assert.equal(
    (await executor.execute(call('{"text":"ok","extra":1}'))).status,
    'error',
  );
});

test('无效ToolSpec、Handler及Schema安全拒绝且注册失败不留记录', () => {
  const registry = new DefaultToolRegistry();
  const invalid: unknown[] = [
    null,
    {},
    { ...spec(), name: 'bad name' },
    { ...spec(), name: 'x'.repeat(65) },
    { ...spec(), description: 1 },
    { ...spec(), parameters: true },
    { ...spec(), parameters: [] },
    { ...spec(), parameters: { type: 'array' } },
    { ...spec(), parameters: { type: 'unknown' } },
    { ...spec(), parameters: { type: 'object', required: 4 } },
    { ...spec(), parameters: { $ref: '#/definitions/absent' } },
    { ...spec(), parameters: { $ref: 'https://offline.invalid/schema' } },
    { ...spec(), parameters: { $async: true, type: 'object' } },
    {
      ...spec(),
      parameters: { type: 'object', unknownKeyword: 'schema-secret' },
    },
    {
      ...spec(),
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', format: 'unavailable-format' } },
      },
    },
  ];
  for (const declaration of invalid)
    assert.throws(
      () => registry.register(declaration as ToolSpec, () => ({ content: '' })),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message.includes('schema-secret'), false);
        assert.equal(error.message.includes('offline.invalid'), false);
        return true;
      },
    );
  assert.throws(
    () => registry.register(spec(), null as unknown as ToolHandler),
    /handler/,
  );
  assert.deepEqual(registry.list(), []);
});

test('JSONSchema本地ref、嵌套对象、enum和数组约束实际生效', async () => {
  const registry = new DefaultToolRegistry();
  const declaration: ToolSpec = {
    name: 'nested',
    description: '',
    parameters: {
      type: 'object',
      properties: {
        person: { $ref: '#/definitions/person' },
        labels: { type: 'array', items: { enum: ['a', 'b'] } },
      },
      required: ['person'],
      additionalProperties: false,
      definitions: {
        person: {
          type: 'object',
          properties: { age: { type: 'integer', minimum: 0 } },
          required: ['age'],
          additionalProperties: false,
        },
      },
    },
  };
  let invoked = 0;
  registry.register(declaration, (args) => {
    invoked++;
    return { content: JSON.stringify(args) };
  });
  const executor = new DefaultToolExecutor(registry, { logger: quiet });
  const base = { id: 'nested-call', name: 'nested' };
  const success = await executor.execute({
    ...base,
    argumentsJson: '{"person":{"age":18},"labels":["a"]}',
  });
  assert.equal(success.status, 'success');
  for (const argumentsJson of [
    '{"person":{"age":-1}}',
    '{"person":{"age":"18"}}',
    '{"person":{"age":18},"labels":["other"]}',
  ]) {
    const result = await executor.execute({ ...base, argumentsJson });
    assert.equal(result.status, 'error');
    if (result.status === 'error')
      assert.equal(result.error.code, 'invalid_arguments');
  }
  assert.equal(invoked, 1);
});

test('JSON解析、对象约束、必需字段、类型及未知字段失败均不调用Handler', async () => {
  let invoked = 0;
  const { executor } = setup(() => {
    invoked++;
    return { content: '' };
  });
  for (const input of [
    '{broken',
    'null',
    '[]',
    '"text"',
    '1',
    'true',
    '{}',
    '{"text":2}',
    '{"text":"ok","other":true}',
  ]) {
    const result = await executor.execute(call(input));
    assert.equal(result.status, 'error');
    if (result.status === 'error')
      assert.equal(result.error.code, 'invalid_arguments');
    assert.equal(result.toolCallId, 'call-1');
    assert.equal(result.name, 'echo');
  }
  assert.equal(invoked, 0);
});

test('校验不补default、不coerce、不removeAdditional，原始ToolCall不变', async () => {
  const registry = new DefaultToolRegistry();
  registry.register(
    {
      name: 'strict',
      description: '',
      parameters: {
        type: 'object',
        properties: { count: { type: 'number', default: 5 } },
        additionalProperties: false,
      },
    },
    (args) => ({ content: JSON.stringify(args) }),
  );
  const executor = new DefaultToolExecutor(registry, { logger: quiet });
  const input = Object.freeze({
    id: 'strict-call',
    name: 'strict',
    argumentsJson: '{}',
  });
  assert.deepEqual(await executor.execute(input), {
    toolCallId: 'strict-call',
    name: 'strict',
    status: 'success',
    content: '{}',
  });
  for (const argumentsJson of ['{"count":"5"}', '{"extra":1}'])
    assert.equal(
      (await executor.execute({ ...input, argumentsJson })).status,
      'error',
    );
  assert.equal(input.argumentsJson, '{}');
});

test('空Schema仍强制参数对象，支持同步/异步Handler并保留调用ID和字符串结果', async () => {
  const registry = new DefaultToolRegistry();
  let signal: AbortSignal | undefined;
  registry.register(
    { name: 'sync', description: '', parameters: {} },
    (_args, context) => {
      signal = context.signal;
      return { content: context.toolCallId };
    },
  );
  registry.register(
    { name: 'async', description: '', parameters: { type: 'object' } },
    async () => ({ content: 'async-content' }),
  );
  const executor = new DefaultToolExecutor(registry, { logger: quiet });
  assert.deepEqual(
    await executor.execute({
      id: 'id-kept',
      name: 'sync',
      argumentsJson: '{}',
    }),
    {
      toolCallId: 'id-kept',
      name: 'sync',
      status: 'success',
      content: 'id-kept',
    },
  );
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
  assert.equal(
    (
      await executor.execute({
        id: 'other',
        name: 'async',
        argumentsJson: '{}',
      })
    ).content,
    'async-content',
  );
  assert.equal(
    (await executor.execute({ id: 'array', name: 'sync', argumentsJson: '[]' }))
      .status,
    'error',
  );
});

test('工具缺失、无效调用与控制选项分别映射固定业务错误', async () => {
  const { executor } = setup();
  const missing = await executor.execute({ ...call(), name: 'absent' });
  assert.equal(missing.status, 'error');
  if (missing.status === 'error')
    assert.equal(missing.error.code, 'tool_not_found');
  for (const input of [
    null,
    {},
    { ...call(), id: '' },
    { ...call(), name: 'bad name' },
    { ...call(), argumentsJson: {} },
  ]) {
    const result = await executor.execute(input as ToolCall);
    assert.equal(result.status, 'error');
    if (result.status === 'error')
      assert.equal(result.error.code, 'invalid_arguments');
  }
  const noIdentity = await executor.execute({} as ToolCall);
  assert.equal(noIdentity.toolCallId, '');
  assert.equal(noIdentity.name, '');
  for (const timeoutMs of [0, -1, 1.5, NaN, 2_147_483_648]) {
    const result = await executor.execute(call(), { timeoutMs });
    assert.equal(result.status, 'error');
    if (result.status === 'error')
      assert.equal(result.error.code, 'invalid_arguments');
  }
});

test('Handler抛错或返回非法结果只执行一次，不泄露原始错误或无效内容', async () => {
  const handlers: ToolHandler[] = [
    () => {
      throw new Error('raw-handler-secret');
    },
    async () => {
      throw new Error('raw-handler-secret');
    },
    (() => 'raw-handler-secret') as unknown as ToolHandler,
    (() => ({ content: 42 })) as unknown as ToolHandler,
    () => {
      throw new ToolExecutionError('timeout', 'raw-handler-secret');
    },
  ];
  for (const handler of handlers) {
    let attempts = 0;
    const { executor } = setup((...args) => {
      attempts++;
      return handler(...args);
    });
    const result = await executor.execute(call());
    assert.equal(result.status, 'error');
    if (result.status === 'error')
      assert.equal(result.error.code, 'execution_failed');
    assert.equal(JSON.stringify(result).includes('raw-handler-secret'), false);
    assert.equal(attempts, 1);
  }
});

test('取消和timeout为独立ToolExecutionError，已取消调用不进入Handler', async () => {
  let attempts = 0;
  const { executor } = setup(() => {
    attempts++;
    return { content: 'ok' };
  });
  const controller = new AbortController();
  controller.abort(new Error('private-reason'));
  await assert.rejects(
    executor.execute(call(), { signal: controller.signal }),
    (error: unknown) => {
      assert.ok(error instanceof ToolExecutionError);
      assert.equal(error.code, 'aborted');
      assert.equal(error.message.includes('private-reason'), false);
      return true;
    },
  );
  assert.equal(attempts, 0);
  const hanging = setup(() => new Promise(() => {}));
  await assert.rejects(
    hanging.executor.execute(call(), { timeoutMs: 40 }),
    (error: unknown) =>
      error instanceof ToolExecutionError && error.code === 'timeout',
  );
});

test('Model桥接保持数据和错误语义，Schema转换结果不共享引用', () => {
  const declaration = spec();
  const model = toModelToolDefinition(declaration);
  assert.deepEqual(model, declaration);
  model.parameters.required = ['changed'];
  assert.deepEqual(declaration, spec());
  assert.deepEqual(
    toToolResultMessage({
      toolCallId: 'id',
      name: 'echo',
      status: 'success',
      content: 'ok',
    }),
    { role: 'tool', toolCallId: 'id', content: 'ok', isError: false },
  );
  assert.deepEqual(
    toToolResultMessage({
      toolCallId: 'id',
      name: 'echo',
      status: 'error',
      content: 'failed',
      error: { code: 'execution_failed', message: 'failed' },
    }),
    { role: 'tool', toolCallId: 'id', content: 'failed', isError: true },
  );
});

test('ToolSpec外层accessor与继承字段不会运行或破坏注册稳定性', () => {
  const registry = new DefaultToolRegistry();
  let invoked = 0;
  for (const key of ['name', 'description', 'parameters']) {
    const declaration = spec();
    Object.defineProperty(declaration, key, {
      enumerable: true,
      get() {
        invoked++;
        return key === 'name' ? 'echo' : 'sensitive-getter-result';
      },
    });
    assert.throws(
      () => registry.register(declaration, () => ({ content: '' })),
      /Invalid tool specification/,
    );
  }
  assert.equal(invoked, 0);
  assert.throws(
    () =>
      registry.register(Object.create(spec()) as ToolSpec, () => ({
        content: '',
      })),
    /Invalid tool specification/,
  );
  assert.deepEqual(registry.list(), []);
});

test('Handler的输出content只读取一次，不能在校验后换成非字符串', async () => {
  let reads = 0;
  const { executor } = setup(() => ({
    get content() {
      reads++;
      return reads === 1 ? 'valid' : (123 as unknown as string);
    },
  }));
  const result = await executor.execute(call());
  assert.equal(result.status, 'success');
  assert.equal(result.content, 'valid');
  assert.equal(reads, 1);
});

test('调用身份和参数只读一次，恶意getter不会生成错误类型的ToolResult字段', async () => {
  let idReads = 0;
  let nameReads = 0;
  let argsReads = 0;
  const { executor } = setup();
  const input: ToolCall = {
    get id() {
      return ++idReads === 1 ? 'stable-id' : (42 as unknown as string);
    },
    get name() {
      return ++nameReads === 1 ? 'echo' : (42 as unknown as string);
    },
    get argumentsJson() {
      return ++argsReads === 1 ? '{"text":"ok"}' : 'invalid-json';
    },
  };
  assert.deepEqual(await executor.execute(input), {
    toolCallId: 'stable-id',
    name: 'echo',
    status: 'success',
    content: 'ok',
  });
  assert.equal(idReads, 1);
  assert.equal(nameReads, 1);
  assert.equal(argsReads, 1);
  const throwing = {
    get id(): string {
      throw new Error('input-secret');
    },
    name: 'echo',
    argumentsJson: '{}',
  };
  const invalid = await executor.execute(throwing);
  assert.equal(invalid.status, 'error');
  if (invalid.status === 'error')
    assert.equal(invalid.error.code, 'invalid_arguments');
  assert.equal(typeof invalid.toolCallId, 'string');
  assert.equal(JSON.stringify(invalid).includes('input-secret'), false);
});
