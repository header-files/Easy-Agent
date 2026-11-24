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

const source = {
  providers: {
    first: {
      type: 'openai-compatible',
      baseURL: 'http://localhost:1234/v1',
      apiKey: '${FIRST_KEY}',
    },
    native: {
      type: 'openai-responses',
      baseURL: 'https://api.openai.com/v1',
      apiKey: '${OPENAI_API_KEY}',
    },
  },
  models: ['first/vendor/model', 'native/gpt-4.1-mini'],
  defaultModel: 'first/vendor/model',
  agent: { maxModelRetries: 5 },
  cli: { stream: false },
};

test('配置优先CLI>env>文件>默认，Provider环境引用安全解析且模型ID按首个斜杠关联', () => {
  const result = resolveConfig({
    fileConfig: source,
    env: {
      FIRST_KEY: 'first-secret',
      OPENAI_API_KEY: 'native-secret',
      EASY_AGENT_DEFAULT_MODEL: 'native/gpt-4.1-mini',
      EASY_AGENT_MAX_MODEL_RETRIES: '3',
      EASY_AGENT_STREAM: 'true',
      LOG_LEVEL: ' WARN ',
    },
    overrides: {
      defaultModel: 'first/vendor/model',
      agent: { maxModelRetries: 0 },
    },
  });
  assert.deepEqual(result, {
    providers: {
      first: {
        type: 'openai-compatible',
        baseURL: 'http://localhost:1234/v1',
        apiKey: 'first-secret',
      },
      native: {
        type: 'openai-responses',
        baseURL: 'https://api.openai.com/v1',
        apiKey: 'native-secret',
      },
    },
    models: ['first/vendor/model', 'native/gpt-4.1-mini'],
    defaultModel: 'first/vendor/model',
    agent: { maxModelRetries: 0 },
    cli: { stream: true },
    logging: { level: 'warn' },
  });
  assert.equal(source.providers.first.apiKey, '${FIRST_KEY}');
});

test('未知Provider类型、非法或重复模型、未知Provider和未注册默认模型安全失败', () => {
  const secret = 'private-offline-fixture';
  const validProvider = {
    providers: {
      local: { type: 'openai-compatible', baseURL: 'http://localhost:1/v1' },
    },
    models: ['local/model'],
    defaultModel: 'local/model',
  };
  const invalid: unknown[] = [
    {},
    { ...validProvider, providers: {} },
    {
      ...validProvider,
      providers: { local: { type: 'unknown', apiKey: secret } },
    },
    {
      ...validProvider,
      providers: { 'bad/id': { type: 'openai-compatible' } },
    },
    {
      ...validProvider,
      providers: {
        local: { type: 'openai-compatible', apiKey: 'k' },
      },
    },
    {
      ...validProvider,
      providers: { vendor: { type: 'deepseek', apiKey: 'k' } },
    },
    { ...validProvider, models: [] },
    { ...validProvider, models: ['missing/model'] },
    { ...validProvider, models: ['local/model', 'local/model'] },
    { ...validProvider, models: ['local/'] },
    { ...validProvider, defaultModel: 'local/unregistered' },
    {
      ...validProvider,
      providers: {
        local: {
          type: 'openai-compatible',
          baseURL: `https://user:${secret}@example.invalid`,
        },
      },
    },
    {
      ...validProvider,
      providers: {
        native: {
          type: 'openai-responses',
          baseURL: 'https://api.openai.com/v1',
          apiKey: '${MISSING_KEY}',
        },
      },
      models: ['native/model'],
      defaultModel: 'native/model',
    },
    {
      ...validProvider,
      providers: {
        native: {
          type: 'openai-responses',
          baseURL: 'https://api.openai.com/v1',
        },
      },
      models: ['native/model'],
      defaultModel: 'native/model',
    },
    { ...validProvider, agent: { maxModelRetries: -1 } },
    { ...validProvider, cli: { stream: secret } },
    { ...validProvider, logging: { level: secret } },
    { ...validProvider, agent: { maxIterations: 1 } },
  ];
  for (const fileConfig of invalid) {
    assert.throws(
      () => resolveConfig({ fileConfig, env: {} }),
      (error: unknown) =>
        error instanceof ConfigurationError &&
        !String(error.stack).includes(secret),
    );
  }
});

test('显式JSON配置加载，不读.env；文件错误安全且不接受Phase 1旧单模型结构', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'easy-agent-config-'));
  try {
    const path = join(directory, 'config.json');
    await writeFile(path, JSON.stringify(source));
    const config = await loadConfig({
      filePath: path,
      env: {
        FIRST_KEY: 'first-secret',
        OPENAI_API_KEY: 'native-secret',
      },
      overrides: { defaultModel: 'native/gpt-4.1-mini' },
    });
    assert.equal(config.defaultModel, 'native/gpt-4.1-mini');
    assert.equal(config.models[0], 'first/vendor/model');
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
    assert.throws(
      () =>
        resolveConfig({
          fileConfig: {
            model: { provider: 'openai-compatible', name: 'old-model' },
          },
        }),
      ConfigurationError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
