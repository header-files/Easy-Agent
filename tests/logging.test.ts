import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  createLogger,
  type LogFields,
  type Logger,
  type LoggerOptions,
  type LogLevel,
} from '../src/index.ts';

const execFileAsync = promisify(execFile);
const levels: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function capture(options: LoggerOptions = {}) {
  const chunks: string[] = [];
  const logger = createLogger({
    env: {},
    ...options,
    destination: {
      write(chunk) {
        chunks.push(chunk);
      },
    },
  });
  return {
    logger,
    records: () =>
      chunks
        .join('')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    text: () => chunks.join(''),
  };
}

test('默认 INFO 阈值与四种日志方法，结构化级别为大写标签', () => {
  const { logger, records } = capture();
  for (const level of levels) logger[level](`${level} message`);
  assert.deepEqual(
    records().map((record) => record.level),
    ['INFO', 'WARN', 'ERROR'],
  );
  assert.deepEqual(
    records().map((record) => record.msg),
    ['info message', 'warn message', 'error message'],
  );
});

test('LOG_LEVEL 配置过滤全部级别，接受大小写和空格，显式配置优先', () => {
  for (const [index, level] of levels.entries()) {
    const { logger, records } = capture({
      env: { LOG_LEVEL: ` ${level.toUpperCase()} ` },
    });
    for (const candidate of levels) logger[candidate](candidate);
    assert.deepEqual(
      records().map((record) => record.level),
      levels.slice(index).map((value) => value.toUpperCase()),
    );
  }
  const { logger, records } = capture({
    level: 'debug',
    env: { LOG_LEVEL: 'ERROR' },
  });
  logger.debug('explicit override');
  assert.equal(records().length, 1);
});

test('无效日志级别安全报错，不在异常中暴露配置值', () => {
  for (const value of [
    '',
    'verbose',
    'silent',
    'trace',
    'fatal',
    'secret-invalid-level',
  ]) {
    assert.throws(
      () => capture({ env: { LOG_LEVEL: value } }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, 'Invalid logging level configuration.');
        assert.equal(error.message.includes('secret-invalid-level'), false);
        return true;
      },
    );
  }
});

test('每条记录包含 ISO 时间、模块、消息和结构化字段，不能覆盖基础字段', () => {
  const start = Date.now();
  const { logger, records, text } = capture({ module: 'runtime.logging' });
  const nested = Object.freeze({ attempt: 1, labels: Object.freeze(['test']) });
  const input = Object.freeze({
    action: 'initialize',
    nested,
    level: 'FAKE',
    time: 'fake-time',
    module: 'fake-module',
    msg: 'fake-message',
  });
  logger.info('ready', input);
  const record = records()[0]!;
  assert.equal(record.level, 'INFO');
  assert.equal(record.module, 'runtime.logging');
  assert.equal(record.msg, 'ready');
  assert.equal(record.action, 'initialize');
  assert.deepEqual(record.nested, nested);
  assert.equal(typeof record.time, 'string');
  assert.match(String(record.time), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(Date.parse(String(record.time)) >= start);
  assert.ok(Date.parse(String(record.time)) <= Date.now());
  assert.equal(text().match(/"module":/g)?.length, 1);
  assert.equal(input.level, 'FAKE');
});

test('子 Logger 继承上下文并隔离模块、绑定快照和同级实例', () => {
  const { logger, records } = capture({ level: 'debug', module: 'bootstrap' });
  const bindings = {
    requestId: 'A',
    nested: { attempt: 1 },
    module: 'injected',
  };
  const childA = logger.child('runtime.alpha', bindings);
  const childB = logger.child('runtime.beta', { requestId: 'B' });
  const descendant = childA.child('runtime.alpha.transport', {
    transport: 'http',
  });
  bindings.requestId = 'mutated';
  bindings.nested.attempt = 99;
  childA.debug('A');
  childB.info('B');
  descendant.warn('nested', { attempt: 2 });
  logger.error('parent');
  const [a, b, nested, parent] = records();
  assert.equal(a?.module, 'runtime.alpha');
  assert.equal(a?.requestId, 'A');
  assert.deepEqual(a?.nested, { attempt: 1 });
  assert.equal(b?.module, 'runtime.beta');
  assert.equal(b?.requestId, 'B');
  assert.equal(b?.nested, undefined);
  assert.equal(nested?.module, 'runtime.alpha.transport');
  assert.equal(nested?.requestId, 'A');
  assert.equal(nested?.transport, 'http');
  assert.equal(nested?.attempt, 2);
  assert.equal(parent?.module, 'bootstrap');
  assert.equal(parent?.requestId, undefined);
});

test('异常记录保留类型、消息、堆栈、cause 和必要自定义字段', () => {
  const { logger, records } = capture();
  const cause = new TypeError('underlying failure');
  const error = Object.assign(new Error('operation failed', { cause }), {
    code: 'E_TEST',
    status: 503,
  });
  logger.error('request failed', { err: error, attempt: 1 });
  const record = records()[0]!;
  const logged = record.err as Record<string, unknown>;
  assert.equal(record.level, 'ERROR');
  assert.equal(logged.name, 'Error');
  assert.equal(logged.message, 'operation failed');
  assert.match(String(logged.stack), /operation failed/);
  assert.equal(logged.code, 'E_TEST');
  assert.equal(logged.status, 503);
  assert.equal((logged.cause as Record<string, unknown>).name, 'TypeError');
  assert.equal(
    (logged.cause as Record<string, unknown>).message,
    'underlying failure',
  );
  assert.equal(error.cause, cause);
});

test('Pino 输出边界统一保护消息、字段、子绑定和异常中的敏感信息', () => {
  const customSecret = 'opaque-example-credential-7392';
  const secrets = [
    'example-api-value',
    'example-token-value',
    'example-password-value',
    customSecret,
  ];
  const { logger, records, text } = capture({
    module: 'auth',
    redactValues: [customSecret],
  });
  const child = logger.child(`service-${customSecret}`, {
    config: { OPENAI_API_KEY: secrets[0], auth: { accessToken: secrets[1] } },
    secret: secrets[2],
  });
  const error = new Error(`Bearer ${secrets[1]} failed: ${customSecret}`, {
    cause: new Error(`password=${secrets[2]}`),
  });
  child.error(`authentication failed for ${customSecret}`, {
    err: error,
    headers: { Authorization: `Bearer ${secrets[0]}` },
    nested: [{ refresh_token: secrets[1] }],
    safe: { result: 'rejected' },
  });
  for (const secret of secrets) assert.equal(text().includes(secret), false);
  assert.equal(text().includes('[REDACTED]'), true);
  assert.deepEqual(records()[0]?.safe, { result: 'rejected' });
  assert.equal(error.message.includes(customSecret), true);
});

test('初始化快照隔离环境、配置对象及显式敏感值列表', () => {
  const env = { LOG_LEVEL: 'DEBUG' };
  const redactValues = ['first-sensitive-value'];
  const { logger, records, text } = capture({ env, redactValues });
  env.LOG_LEVEL = 'ERROR';
  redactValues[0] = 'different-value';
  logger.debug('first-sensitive-value');
  assert.equal(records().length, 1);
  assert.equal(text().includes('first-sensitive-value'), false);
});

test('日志禁用级别不序列化字段，创建子 Logger 不会输出日志', () => {
  const { logger, records } = capture({ level: 'error' });
  const invalid = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('must not inspect');
      },
    },
  );
  logger.debug('filtered', invalid);
  logger.info('filtered', invalid);
  logger.warn('filtered', invalid);
  logger.child('module');
  assert.equal(records().length, 0);
});

test('默认使用 stderr 并读取初始化边界环境，源码导入无日志副作用', async () => {
  const moduleUrl = new URL('../src/index.ts', import.meta.url).href;
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `const { createLogger } = await import(${JSON.stringify(moduleUrl)});
     const logger = createLogger({module:'stderr-check'});
     logger.debug('debug-hidden'); logger.info('info-hidden');
     logger.warn('warning-visible');`,
    ],
    { env: { ...process.env, LOG_LEVEL: 'WARN' } },
  );
  assert.equal(stdout, '');
  const records = stderr
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.level, 'WARN');
  assert.equal(records[0]?.module, 'stderr-check');
  assert.equal(records[0]?.msg, 'warning-visible');
});

test('消费方可使用替代 Logger，实现不需要 Pino 类型', () => {
  const observed: Array<{
    level: LogLevel;
    module: string;
    message: string;
    fields?: LogFields;
  }> = [];
  function memoryLogger(module: string, bindings: LogFields = {}): Logger {
    const write = (level: LogLevel, message: string, fields?: LogFields) => {
      observed.push({
        level,
        module,
        message,
        fields: { ...bindings, ...fields },
      });
    };
    return {
      debug: (message, fields) => write('debug', message, fields),
      info: (message, fields) => write('info', message, fields),
      warn: (message, fields) => write('warn', message, fields),
      error: (message, fields) => write('error', message, fields),
      child: (name, fields) => memoryLogger(name, { ...bindings, ...fields }),
    };
  }
  function initialize(logger: Logger) {
    logger.info('initialized', { ready: true });
  }
  initialize(
    memoryLogger('root').child('runtime.logging', { source: 'replacement' }),
  );
  assert.deepEqual(observed, [
    {
      level: 'info',
      module: 'runtime.logging',
      message: 'initialized',
      fields: { source: 'replacement', ready: true },
    },
  ]);
});
