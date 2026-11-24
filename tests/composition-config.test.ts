import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ConfigurationError,
  loadConfig,
  resolveConfig,
} from '../src/composition/index.ts';

test('配置优先CLI>env>文件>默认，参数按键合并且连接密钥保持配置边界', () => {
  const file = {
    model: {
      name: 'file',
      baseUrl: 'http://localhost:1234/v1',
      parameters: { temperature: 0.3, top_p: 0.8 },
    },
    agent: { maxModelRetries: 5 },
    cli: { stream: false },
  };
  const result = resolveConfig({
    fileConfig: file,
    env: {
      EASY_AGENT_MODEL: 'env',
      OPENAI_API_KEY: 'offline-test-secret',
      EASY_AGENT_MAX_MODEL_RETRIES: '3',
      EASY_AGENT_STREAM: 'true',
      LOG_LEVEL: ' WARN ',
    },
    overrides: {
      model: { name: 'cli', parameters: { temperature: 0.7 } },
      agent: { maxModelRetries: 0 },
    },
  });
  assert.deepEqual(result, {
    model: {
      provider: 'openai-compatible',
      name: 'cli',
      baseUrl: 'http://localhost:1234/v1',
      apiKey: 'offline-test-secret',
      parameters: { temperature: 0.7, top_p: 0.8 },
    },
    agent: { maxModelRetries: 0 },
    cli: { stream: true },
    logging: { level: 'warn' },
  });
  assert.equal(file.model.parameters.temperature, 0.3);
  assert.deepEqual(
    resolveConfig({ fileConfig: { model: { name: 'local' } } }),
    {
      model: { provider: 'openai-compatible', name: 'local' },
      agent: { maxModelRetries: 2 },
      cli: { stream: true },
      logging: { level: 'info' },
    },
  );
});

test('配置缺失与非法配置安全失败，不包含凭据、URL、原始内容', () => {
  const secret = 'private-offline-fixture';
  const invalid: unknown[] = [
    {},
    { model: { name: ' ' } },
    { model: { name: 'x', baseUrl: `https://user:${secret}@example.invalid` } },
    { model: { name: 'x', baseUrl: `http://localhost/?token=${secret}` } },
    { model: { name: 'x', apiKey: `x\n${secret}` } },
    { model: { name: 'x', provider: secret } },
    { model: { name: 'x' }, agent: { maxModelRetries: -1 } },
    { model: { name: 'x' }, agent: { maxModelRetries: 1.2 } },
    { model: { name: 'x' }, cli: { stream: secret } },
    { model: { name: 'x' }, logging: { level: secret } },
    { model: { name: 'x', parameters: { temperature: 3 } } },
    { model: { name: 'x', parameters: { maxOutputTokens: 0 } } },
    { model: { name: 'x', parameters: { top_p: undefined } } },
    { model: { name: 'x' }, agent: { maxIterations: 1 } },
  ];
  for (const fileConfig of invalid)
    assert.throws(
      () => resolveConfig({ fileConfig }),
      (error: unknown) =>
        error instanceof ConfigurationError &&
        !String(error.stack).includes(secret),
    );
  assert.throws(
    () =>
      resolveConfig({
        env: { EASY_AGENT_MODEL: 'x', EASY_AGENT_MAX_MODEL_RETRIES: secret },
      }),
    ConfigurationError,
  );
  assert.throws(
    () =>
      resolveConfig({
        env: { EASY_AGENT_MODEL: 'x', EASY_AGENT_STREAM: secret },
      }),
    ConfigurationError,
  );
  const overridden = resolveConfig({
    env: {
      EASY_AGENT_MODEL: 'x',
      EASY_AGENT_MAX_MODEL_RETRIES: secret,
      EASY_AGENT_STREAM: secret,
    },
    overrides: { agent: { maxModelRetries: 0 }, cli: { stream: true } },
  });
  assert.equal(overridden.agent.maxModelRetries, 0);
  assert.equal(overridden.cli.stream, true);
});

test('显式JSON配置加载，不读.env；文件错误安全且解析后数据与源隔离', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easy-agent-config-'));
  try {
    const path = join(directory, 'config.json');
    await writeFile(
      path,
      JSON.stringify({
        model: { name: 'fixture', parameters: { nested: { value: 1 } } },
      }),
    );
    const config = await loadConfig({
      filePath: path,
      env: {},
      overrides: { model: { name: 'override' } },
    });
    assert.equal(config.model.name, 'override');
    await writeFile(path, 'private-invalid-json');
    await assert.rejects(
      loadConfig({ filePath: path, env: {} }),
      (error: unknown) =>
        error instanceof ConfigurationError &&
        !String(error).includes('private-invalid-json'),
    );
    await assert.rejects(
      loadConfig({ filePath: join(directory, 'missing'), env: {} }),
      ConfigurationError,
    );
    await assert.rejects(loadConfig({ env: {} }), ConfigurationError);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
