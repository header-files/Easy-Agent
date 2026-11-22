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
       typeof entry.DefaultAgentLoop].join(':'));`,
  ]);

  assert.equal(
    stdout,
    'Module:function:function:function:function:function:function:function',
  );
  assert.equal(stderr, '');
});
