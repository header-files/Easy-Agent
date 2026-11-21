import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeFields, safeText } from '../src/runtime/logging/redact.ts';

test('敏感字段名忽略大小写与分隔符，并递归覆盖数组及嵌套对象', () => {
  const fields = {
    apiKey: 'private-key-a',
    API_KEY: 'private-key-b',
    openai_api_key: 'private-key-c',
    token: 'private-token',
    accessToken: 'private-access',
    refresh_token: 'private-refresh',
    nested: [
      {
        Authorization: 'Bearer private-auth',
        'Set-Cookie': 'sid=private-cookie',
      },
      { password: 'private-password', clientSecret: 'private-client-secret' },
    ],
    usage: { inputTokens: 7, outputTokens: 9 },
  };
  const before = structuredClone(fields);
  const sanitized = safeFields(fields);
  const encoded = JSON.stringify(sanitized);
  assert.ok(!encoded.includes('private-'));
  assert.equal(sanitized.apiKey, '[REDACTED]');
  assert.deepEqual(sanitized.usage, { inputTokens: 7, outputTokens: 9 });
  assert.deepEqual(fields, before);
});

test('消息中的认证方案、标签值、URL 用户信息和敏感查询参数脱敏', () => {
  const examples = [
    ['Bearer raw-bearer-secret', 'raw-bearer-secret'],
    ['Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
    ['request failed api_key="raw labelled secret"', 'raw labelled secret'],
    [
      'status: failed password=raw password with spaces',
      'raw password with spaces',
    ],
    ['{"access_token":"raw-json-secret","ok":true}', 'raw-json-secret'],
    [
      'GET https://username:userpass@host.test/v1?api_key=query-secret&seed=42',
      'userpass',
    ],
    [
      'GET https://host.test/?access%5Ftoken=encoded-query-secret&ok=1',
      'encoded-query-secret',
    ],
    [
      'Cookie: session=cookie-secret; second=other-cookie-secret',
      'other-cookie-secret',
    ],
    [
      'provider key sk-proj-1234567890abcdefghijk',
      'sk-proj-1234567890abcdefghijk',
    ],
  ];
  for (const [input, secret] of examples) {
    assert.ok(input && secret);
    const output = safeText(input);
    assert.ok(!output.includes(secret), output);
    assert.ok(output.includes('[REDACTED]'), output);
  }
  assert.equal(safeText('request id=42 status=ok'), 'request id=42 status=ok');
});

test('显式 redactValues 覆盖无标签的凭据及正则特殊字符且忽略空字符串', () => {
  const secret = 'opaque.[key]+$';
  assert.equal(
    safeText(`failed: ${secret}`, ['', secret]),
    'failed: [REDACTED]',
  );
  const output = safeFields(
    { context: [`prefix ${secret} suffix`], [secret]: secret },
    [secret],
  );
  assert.ok(!JSON.stringify(output).includes(secret));
  assert.equal(
    safeText('an unknowable opaque value'),
    'an unknowable opaque value',
  );
});

test('显式秘密值与敏感标签或查询名称重合时不能破坏通用脱敏', () => {
  for (const input of [
    'api_token=hidden-value',
    'https://host.test/?access_token=hidden-value&seed=42',
    '{"refresh_token":"hidden-value"}',
  ]) {
    const output = safeText(input, ['token']);
    assert.ok(!output.includes('hidden-value'), output);
    assert.ok(!output.includes('token'), output);
    assert.ok(output.includes('[REDACTED]'), output);
  }
  const overlappingSecret = 'Bearer visible-prefix opaque-secret-suffix';
  assert.equal(
    safeText(`failed: ${overlappingSecret}`, [overlappingSecret]),
    'failed: [REDACTED]',
  );
  const url = safeText('https://user:pass@host/a', ['pass@host/a']);
  assert.equal(url, 'https://[REDACTED]');
  for (const secret of ['pass', 'host', '/a']) assert.ok(!url.includes(secret));
  assert.equal(safeText('ababa', ['aba']), '[REDACTED]');
});

test('原生 Error 的名称、消息、堆栈、cause 和自定义字段均先序列化再脱敏', () => {
  const cause = Object.assign(new Error('password=cause-password'), {
    refreshToken: 'cause-token',
  });
  const error = Object.assign(new TypeError('failed with Bearer top-secret'), {
    cause,
    details: { API_KEY: 'detail-secret', context: 'plain-opaque-secret' },
  });
  const result = safeFields({ err: error }, ['plain-opaque-secret']);
  const err = result.err as Record<string, unknown>;
  const encoded = JSON.stringify(result);
  assert.equal(err.name, 'TypeError');
  assert.equal(typeof err.message, 'string');
  assert.equal(typeof err.stack, 'string');
  assert.ok((err.stack as string).includes('logging-redaction.test.ts'));
  for (const secret of [
    'cause-password',
    'cause-token',
    'top-secret',
    'detail-secret',
    'plain-opaque-secret',
  ])
    assert.ok(!encoded.includes(secret), encoded);
  assert.equal(error.details.API_KEY, 'detail-secret');
});

test('自定义 toJSON、普通 getter 和异常 getter 不能绕过脱敏或使日志崩溃', () => {
  let invoked = 0;
  const source = {
    safe: true,
    toJSON() {
      invoked++;
      return { leaked: 'hidden-secret' };
    },
    get hidden() {
      invoked++;
      throw new Error('getter-secret');
    },
  };
  const error = new Error('safe failure');
  Object.defineProperty(error, 'stack', {
    get() {
      invoked++;
      throw new Error('stack-secret');
    },
    enumerable: true,
  });
  const messageGetterError = new Error('safe failure');
  Object.defineProperty(messageGetterError, 'message', {
    get() {
      invoked++;
      throw new Error('error-message-getter-secret');
    },
  });
  const output = safeFields({ source, error, messageGetterError });
  const encoded = JSON.stringify(output);
  assert.equal(invoked, 0);
  assert.ok(!encoded.includes('hidden-secret'));
  assert.ok(!encoded.includes('getter-secret'));
  assert.ok(!encoded.includes('stack-secret'));
  assert.equal((output.source as Record<string, unknown>).hidden, '[Accessor]');
});

test('循环、特殊属性名、抛错 Proxy、深层和超大数组均安全且有界', () => {
  const circular: Record<string, unknown> = { name: 'root' };
  circular.self = circular;
  const special = JSON.parse(
    '{"__proto__":{"apiKey":"proto-secret"},"constructor":{"token":"constructor-secret"}}',
  ) as Record<string, unknown>;
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('proxy-secret');
      },
    },
  );
  let deep: Record<string, unknown> = { password: 'too-deep-secret' };
  for (let index = 0; index < 100; index++) deep = { child: deep };
  const output = safeFields({
    circular,
    special,
    proxy,
    deep,
    huge: Array.from({ length: 1_100 }, () => 'value'),
  });
  const encoded = JSON.stringify(output);
  assert.ok(encoded.includes('[Circular]'));
  assert.ok(encoded.includes('[Truncated]'));
  assert.ok(encoded.includes('[Unserializable]'));
  for (const secret of [
    'proto-secret',
    'constructor-secret',
    'proxy-secret',
    'too-deep-secret',
  ])
    assert.ok(!encoded.includes(secret), encoded);
  assert.equal(Object.getPrototypeOf(output.special), Object.prototype);
  assert.ok(Object.hasOwn(output.special as object, '__proto__'));
});
