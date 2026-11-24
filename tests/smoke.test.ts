import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('TypeScript 源码入口能够作为 ESM 加载', async () => {
  const entry = await import('../src/index.ts');

  assert.equal(Object.prototype.toString.call(entry), '[object Module]');
  assert.equal(typeof entry.createLogger, 'function');
  assert.equal(typeof entry.ModelError, 'function');
  assert.equal(typeof entry.OpenAICompatibleModelClient, 'function');
  assert.equal(typeof entry.ToolExecutionError, 'function');
  assert.equal(typeof entry.DefaultToolRegistry, 'function');
  assert.equal(typeof entry.DefaultToolExecutor, 'function');
  assert.equal(typeof entry.DefaultAgentLoop, 'function');
  assert.equal(typeof entry.DefaultExecutionEngine, 'function');
  assert.equal(typeof entry.DefaultAgentManager, 'function');
  assert.equal(typeof entry.SessionEventBufferOverflowError, 'function');
  assert.equal(typeof entry.AgentApplicationError, 'function');
  assert.equal(typeof entry.DefaultAgentApplicationService, 'function');
  assert.equal(typeof entry.ConfigurationError, 'function');
  assert.equal(typeof entry.resolveConfig, 'function');
  assert.equal(typeof entry.loadConfig, 'function');
  assert.equal(typeof entry.BootstrapError, 'function');
  assert.equal(typeof entry.bootstrap, 'function');
});

test('构建入口能够由 Node.js 直接作为 JavaScript ESM 加载', async () => {
  const entryUrl = new URL('../dist/index.js', import.meta.url);
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    '--no-strip-types',
    '--input-type=module',
    '--eval',
    `const entry = await import(${JSON.stringify(entryUrl.href)});
     process.stdout.write([entry[Symbol.toStringTag], typeof entry.createLogger, typeof entry.ModelError,
       typeof entry.OpenAICompatibleModelClient, typeof entry.ToolExecutionError,
       typeof entry.DefaultToolRegistry, typeof entry.DefaultToolExecutor,
       typeof entry.DefaultAgentLoop, typeof entry.DefaultExecutionEngine,
       typeof entry.DefaultAgentManager, typeof entry.SessionEventBufferOverflowError,
       typeof entry.AgentApplicationError, typeof entry.DefaultAgentApplicationService,
       typeof entry.ConfigurationError, typeof entry.resolveConfig, typeof entry.loadConfig,
       typeof entry.BootstrapError, typeof entry.bootstrap].join(':'));`,
  ]);

  assert.equal(
    stdout,
    `Module:${Array<string>(17).fill('function').join(':')}`,
  );
  assert.equal(stderr, '');
});

test('编译后CLI入口可显示帮助/版本，导入时不执行且不需模型配置', async () => {
  const bin = new URL('../dist/application/cli/bin.js', import.meta.url);
  const help = await execFileAsync(
    process.execPath,
    ['--no-strip-types', bin.pathname, '--help'],
    { env: {} },
  );
  assert.match(help.stdout, /easy-agent chat/);
  assert.equal(help.stderr, '');
  const version = await execFileAsync(
    process.execPath,
    [bin.pathname, '--version'],
    { env: {} },
  );
  assert.equal(version.stdout.trim(), 'easy-agent 0.1.0');
  assert.equal(version.stderr, '');
  const imported = await execFileAsync(
    process.execPath,
    [
      '--no-strip-types',
      '--input-type=module',
      '--eval',
      `await import(${JSON.stringify(bin.href)});`,
    ],
    { env: {} },
  );
  assert.equal(imported.stdout, '');
  assert.equal(imported.stderr, '');
});
