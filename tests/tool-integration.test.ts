import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import {
  createLogger,
  DefaultToolExecutor,
  DefaultToolRegistry,
  ToolExecutionError,
  toModelToolDefinition,
  toToolResultMessage,
  type ModelToolCall,
  type Logger,
  type LogFields,
  type LogLevel,
  type ToolCall,
  type ToolHandlerOutput,
  type ToolRegistry,
  type ToolSpec,
} from '../src/index.ts';

const quiet = createLogger({
  env: {},
  level: 'error',
  destination: { write() {} },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function spec(name = 'echo'): ToolSpec {
  return {
    name,
    description: 'Echo a label',
    parameters: {
      type: 'object',
      properties: { label: { type: 'string' } },
      required: ['label'],
      additionalProperties: false,
    },
  };
}

function call(id: string, name = 'echo', label = id): ToolCall {
  return { id, name, argumentsJson: JSON.stringify({ label }) };
}

test(
  '同一 Executor 不同工具真正重叠并乱序完成，调用参数、ID 和信号各自隔离',
  { timeout: 3000 },
  async () => {
    const registry = new DefaultToolRegistry();
    const arrived = deferred<void>();
    const gates = new Map<
      string,
      ReturnType<typeof deferred<ToolHandlerOutput>>
    >();
    const signals: AbortSignal[] = [];
    for (const name of ['alpha', 'beta']) {
      registry.register(spec(name), (args, context) => {
        assert.equal(args.label, context.toolCallId);
        signals.push(context.signal);
        const gate = deferred<ToolHandlerOutput>();
        gates.set(context.toolCallId, gate);
        if (gates.size === 3) arrived.resolve();
        return gate.promise;
      });
    }
    const executor = new DefaultToolExecutor(registry, { logger: quiet });
    const requests = [
      call('one', 'alpha'),
      call('two', 'beta'),
      call('three', 'alpha'),
    ];
    const before = structuredClone(requests);
    const tasks = requests.map((value) => executor.execute(value));
    await arrived.promise;
    assert.equal(new Set(signals).size, 3);
    for (const id of ['three', 'one', 'two'])
      gates.get(id)!.resolve({ content: id });
    const results = await Promise.all(tasks);
    assert.deepEqual(
      results.map((value) => [value.toolCallId, value.name, value.content]),
      [
        ['one', 'alpha', 'one'],
        ['two', 'beta', 'two'],
        ['three', 'alpha', 'three'],
      ],
    );
    assert.ok(results.every((value) => value.status === 'success'));
    assert.deepEqual(requests, before);
  },
);

test(
  '注销及重新注册不影响在途 Handler，后续新调用使用新定义',
  { timeout: 3000 },
  async () => {
    const registry = new DefaultToolRegistry();
    const started = deferred<void>();
    const oldHandler = deferred<ToolHandlerOutput>();
    registry.register(spec(), () => {
      started.resolve();
      return oldHandler.promise;
    });
    const executor = new DefaultToolExecutor(registry, { logger: quiet });
    const active = executor.execute(call('active'));
    await started.promise;
    assert.equal(registry.unregister('echo'), true);
    const missing = await executor.execute(call('missing'));
    assert.equal(missing.status, 'error');
    if (missing.status === 'error')
      assert.equal(missing.error.code, 'tool_not_found');
    registry.register(spec(), () => ({ content: 'new handler' }));
    assert.equal((await executor.execute(call('new'))).content, 'new handler');
    oldHandler.resolve({ content: 'old handler completed' });
    assert.equal((await active).content, 'old handler completed');
  },
);

test('Executor 兼容替代 Registry，每次调用只查询一次并保留稳定快照', async () => {
  const backing = new DefaultToolRegistry();
  backing.register(spec(), () => ({ content: 'ok' }));
  let queries = 0;
  const registry: ToolRegistry = {
    register: (definition, handler) => backing.register(definition, handler),
    unregister: (name) => backing.unregister(name),
    get: (name) => {
      queries++;
      return backing.get(name);
    },
    list: () => backing.list(),
  };
  const executor = new DefaultToolExecutor(registry, { logger: quiet });
  assert.equal((await executor.execute(call('one'))).status, 'success');
  assert.equal(queries, 1);
});

test('工具查询期间触发主动取消时，取消优先于工具不存在的业务结果', async () => {
  const backing = new DefaultToolRegistry();
  const controller = new AbortController();
  const registry: ToolRegistry = {
    register: (definition, handler) => backing.register(definition, handler),
    unregister: (name) => backing.unregister(name),
    get: (name) => {
      controller.abort();
      return backing.get(name);
    },
    list: () => backing.list(),
  };
  const executor = new DefaultToolExecutor(registry, { logger: quiet });
  await assert.rejects(
    executor.execute(call('cancelled'), { signal: controller.signal }),
    (error: unknown) =>
      error instanceof ToolExecutionError && error.code === 'aborted',
  );
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test(
  '取消不响应 signal 的 Handler 及时停止等待，其他调用继续，副作用未被伪称回滚',
  { timeout: 3000 },
  async () => {
    const registry = new DefaultToolRegistry();
    const started = deferred<void>();
    const slow = deferred<ToolHandlerOutput>();
    const survivor = deferred<ToolHandlerOutput>();
    let signal: AbortSignal | undefined;
    let sideEffects = 0;
    registry.register(spec(), async (args, context) => {
      if (args.label === 'slow') {
        signal = context.signal;
        started.resolve();
        const result = await slow.promise;
        sideEffects++;
        return result;
      }
      return survivor.promise;
    });
    const executor = new DefaultToolExecutor(registry, { logger: quiet });
    const controller = new AbortController();
    const rejected = assert.rejects(
      executor.execute(call('cancel', 'echo', 'slow'), {
        signal: controller.signal,
      }),
      (error: unknown) =>
        error instanceof ToolExecutionError && error.code === 'aborted',
    );
    const other = executor.execute(call('other'));
    await started.promise;
    controller.abort(new Error('PRIVATE_ABORT_REASON'));
    await rejected;
    assert.equal(signal?.aborted, true);
    assert.equal(sideEffects, 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    survivor.resolve({ content: 'other completed' });
    assert.equal((await other).status, 'success');
    slow.resolve({ content: 'late underlying completion' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sideEffects, 1);
  },
);

test(
  '超时与主动取消分开处理，并接管超时后迟到的 Handler 拒绝',
  { timeout: 3000 },
  async () => {
    const registry = new DefaultToolRegistry();
    const late = deferred<ToolHandlerOutput>();
    const signals: AbortSignal[] = [];
    let invoked = 0;
    registry.register(spec(), (_args, context) => {
      invoked++;
      signals.push(context.signal);
      return late.promise;
    });
    const executor = new DefaultToolExecutor(registry, { logger: quiet });
    await assert.rejects(
      executor.execute(call('timeout'), { timeoutMs: 200 }),
      (error: unknown) =>
        error instanceof ToolExecutionError && error.code === 'timeout',
    );
    assert.equal(signals[0]?.aborted, true);
    assert.equal(invoked, 1);
    late.reject(new Error('PRIVATE_LATE_HANDLER_FAILURE'));
    await new Promise((resolve) => setImmediate(resolve));
  },
);

test('预先取消不会调用 Handler，成功调用清理外部监听器及超时定时器', async () => {
  const registry = new DefaultToolRegistry();
  let invoked = 0;
  let handlerSignal: AbortSignal | undefined;
  registry.register(spec(), (_args, context) => {
    invoked++;
    handlerSignal = context.signal;
    return { content: 'ok' };
  });
  const executor = new DefaultToolExecutor(registry, { logger: quiet });
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    executor.execute(call('cancel'), { signal: cancelled.signal }),
    (error: unknown) =>
      error instanceof ToolExecutionError && error.code === 'aborted',
  );
  assert.equal(invoked, 0);
  const controller = new AbortController();
  assert.equal(
    (
      await executor.execute(call('success'), {
        signal: controller.signal,
        timeoutMs: 200,
      })
    ).status,
    'success',
  );
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await new Promise((resolve) => setTimeout(resolve, 230));
  assert.equal(handlerSignal?.aborted, false);
});

test(
  '一个调用失败不会污染同实例的成功调用，也不自动重试',
  { timeout: 3000 },
  async () => {
    const registry = new DefaultToolRegistry();
    const started = deferred<void>();
    const gate = deferred<ToolHandlerOutput>();
    let invoked = 0;
    registry.register(spec(), (args) => {
      invoked++;
      if (args.label === 'bad') throw new Error('PRIVATE_HANDLER_FAILURE');
      started.resolve();
      return gate.promise;
    });
    const executor = new DefaultToolExecutor(registry, { logger: quiet });
    const good = executor.execute(call('good'));
    await started.promise;
    const bad = await executor.execute(call('bad'));
    assert.equal(bad.status, 'error');
    if (bad.status === 'error') {
      assert.equal(bad.error.code, 'execution_failed');
      assert.equal(JSON.stringify(bad).includes('PRIVATE_'), false);
    }
    gate.resolve({ content: 'good' });
    assert.equal((await good).status, 'success');
    assert.equal(invoked, 2);
  },
);

test('注册输入、get/list返回值和Model桥转换都不能改写内部Schema', async () => {
  const registry = new DefaultToolRegistry();
  const original = spec();
  registry.register(original, (args) => ({ content: String(args.label) }));
  const copy = registry.get('echo')!;
  const listed = registry.list();
  const mapped = toModelToolDefinition(copy.spec);
  original.parameters.required = [];
  copy.spec.parameters.required = [];
  listed[0]!.parameters.additionalProperties = true;
  mapped.parameters.required = [];
  const executor = new DefaultToolExecutor(registry, { logger: quiet });
  const invalid = await executor.execute({
    id: 'invalid',
    name: 'echo',
    argumentsJson: '{}',
  });
  assert.equal(invalid.status, 'error');
  if (invalid.status === 'error')
    assert.equal(invalid.error.code, 'invalid_arguments');
  assert.deepEqual(registry.get('echo')?.spec.parameters.required, ['label']);
  const modelCall: ModelToolCall = call('model-call', 'echo', 'value');
  const result = await executor.execute(modelCall);
  assert.deepEqual(toToolResultMessage(result), {
    role: 'tool',
    toolCallId: 'model-call',
    content: 'value',
    isError: false,
  });
  assert.deepEqual(toToolResultMessage(invalid), {
    role: 'tool',
    toolCallId: 'invalid',
    content: invalid.content,
    isError: true,
  });
});

test('JSON Schema 不填默认值、不转换类型、不删除未知字段', async () => {
  const registry = new DefaultToolRegistry();
  let received: Record<string, unknown> | undefined;
  registry.register(
    {
      name: 'strict_input',
      description: 'Strict input',
      parameters: {
        type: 'object',
        properties: { count: { type: 'integer', default: 7 } },
        additionalProperties: true,
      },
    },
    (args) => {
      received = args;
      return { content: 'ok' };
    },
  );
  const executor = new DefaultToolExecutor(registry, { logger: quiet });
  const input = {
    id: 'one',
    name: 'strict_input',
    argumentsJson: '{"extra":"retained"}',
  };
  const original = structuredClone(input);
  assert.equal((await executor.execute(input)).status, 'success');
  assert.deepEqual(received, { extra: 'retained' });
  assert.deepEqual(input, original);
  const invalid = await executor.execute({
    ...input,
    argumentsJson: '{"count":"7"}',
  });
  assert.equal(invalid.status, 'error');
  assert.deepEqual(received, { extra: 'retained' });
});

test('不同工具可复用同一个本地Schema ID，不共享校验或参数状态', async () => {
  const registry = new DefaultToolRegistry();
  registry.register(
    {
      name: 'string_arg',
      description: '',
      parameters: {
        $id: 'https://schema.invalid/shared',
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
    },
    () => ({ content: 'string' }),
  );
  registry.register(
    {
      name: 'number_arg',
      description: '',
      parameters: {
        $id: 'https://schema.invalid/shared',
        type: 'object',
        properties: { value: { type: 'number' } },
        required: ['value'],
      },
    },
    () => ({ content: 'number' }),
  );
  const executor = new DefaultToolExecutor(registry, { logger: quiet });
  const [a, b] = await Promise.all([
    executor.execute({
      id: 'a',
      name: 'string_arg',
      argumentsJson: '{"value":"text"}',
    }),
    executor.execute({
      id: 'b',
      name: 'number_arg',
      argumentsJson: '{"value":3}',
    }),
  ]);
  assert.deepEqual([a.status, b.status], ['success', 'success']);
});

test('工具日志仅记录安全生命周期元数据，不泄露参数、结果、调用ID或Handler异常', async () => {
  const entries: Array<{ level: LogLevel; module: string; fields: LogFields }> =
    [];
  function logger(module = 'test'): Logger {
    const write = (level: LogLevel, _message: string, fields: LogFields = {}) =>
      entries.push({ level, module, fields });
    return {
      debug: (message, fields) => {
        write('debug', message, fields);
      },
      info: (message, fields) => {
        write('info', message, fields);
      },
      warn: (message, fields) => {
        write('warn', message, fields);
      },
      error: (message, fields) => {
        write('error', message, fields);
      },
      child: (name) => logger(name),
    };
  }
  const registry = new DefaultToolRegistry();
  const declaration = spec();
  declaration.description = 'PRIVATE_SPEC_DESCRIPTION';
  registry.register(declaration, (args) => {
    if (args.label === 'PRIVATE_FAILURE_ARGUMENT')
      throw new Error('PRIVATE_HANDLER_ERROR');
    return { content: 'PRIVATE_TOOL_RESULT' };
  });
  const executor = new DefaultToolExecutor(registry, { logger: logger() });
  assert.equal(
    (
      await executor.execute(
        call('PRIVATE_CALL_ID', 'echo', 'PRIVATE_ARGUMENT'),
      )
    ).status,
    'success',
  );
  const failed = await executor.execute(
    call('PRIVATE_FAILED_CALL_ID', 'echo', 'PRIVATE_FAILURE_ARGUMENT'),
  );
  assert.equal(failed.status, 'error');
  assert.equal(JSON.stringify(entries).includes('PRIVATE_'), false);
  assert.equal(entries.length, 4);
  const starts = entries.filter(
    (entry) => entry.fields.event === 'tool.execution.started',
  );
  const finishes = entries.filter(
    (entry) => entry.fields.event === 'tool.execution.completed',
  );
  assert.deepEqual(
    starts.map((entry) => entry.level),
    ['debug', 'debug'],
  );
  assert.deepEqual(
    finishes.map((entry) => entry.level),
    ['info', 'error'],
  );
  assert.equal(
    new Set(starts.map((entry) => entry.fields.executionId)).size,
    2,
  );
  for (const entry of entries) {
    assert.equal(entry.module, 'runtime.tool.executor');
    assert.equal(typeof entry.fields.executionId, 'string');
    for (const key of Object.keys(entry.fields))
      assert.ok(
        [
          'executionId',
          'event',
          'name',
          'status',
          'durationMs',
          'code',
        ].includes(key),
      );
  }
});

test('同步及异步日志后端故障不会改变工具执行结果或控制异常', async () => {
  const registry = new DefaultToolRegistry();
  registry.register(spec(), () => ({ content: 'ok' }));
  const syncFail = () => {
    throw new Error('PRIVATE_LOGGER_FAILURE');
  };
  const asyncFail = async () => {
    throw new Error('PRIVATE_ASYNC_LOGGER_FAILURE');
  };
  for (const fail of [syncFail, asyncFail]) {
    const logger: Logger = {
      debug: fail,
      info: fail,
      warn: fail,
      error: fail,
      child: () => logger,
    };
    const executor = new DefaultToolExecutor(registry, { logger });
    assert.equal((await executor.execute(call('success'))).status, 'success');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      executor.execute(call('cancel'), { signal: controller.signal }),
      (error: unknown) =>
        error instanceof ToolExecutionError && error.code === 'aborted',
    );
    await new Promise((resolve) => setImmediate(resolve));
  }
  const logger: Logger = {
    debug: syncFail,
    info: syncFail,
    warn: syncFail,
    error: syncFail,
    child: syncFail,
  };
  assert.equal(
    (
      await new DefaultToolExecutor(registry, { logger }).execute(
        call('child-failure'),
      )
    ).status,
    'success',
  );
});
