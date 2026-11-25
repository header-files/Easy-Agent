import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ApprovalService } from '../src/runtime/approval/index.ts';
import { writeFileOverwrite } from '../src/runtime/tool/builtins/safe-fs.ts';
import {
  DefaultToolRegistry,
  GuardedToolExecutor,
} from '../src/runtime/tool/index.ts';

test('审批参数深冻结：监听器无法改嵌套字段，Handler 收到批准快照', async () => {
  const registry = new DefaultToolRegistry();
  let seen: unknown;
  registry.register(
    {
      name: 'echo_nested',
      description: 'echo nested',
      parameters: {
        type: 'object',
        properties: {
          meta: { type: 'object', additionalProperties: true },
        },
        required: ['meta'],
        additionalProperties: false,
      },
    },
    (args) => {
      seen = args.meta;
      return { content: JSON.stringify(args.meta) };
    },
    { approval: 'always', workspaceAccess: 'none' },
  );
  const approval = new ApprovalService();
  approval.subscribe((request) => {
    if (request.status !== 'PENDING') return;
    assert.throws(() => {
      (request.arguments.meta as { tag: string }).tag = 'tampered';
    });
    approval.decide(request.id, 'approve');
  });
  const executor = new GuardedToolExecutor(registry, { approval });
  const result = await executor.execute(
    {
      id: '1',
      name: 'echo_nested',
      argumentsJson: JSON.stringify({ meta: { tag: 'original' } }),
    },
    { executionId: 'e1' },
  );
  assert.equal(result.status, 'success');
  assert.deepEqual(seen, { tag: 'original' });
  assert.equal(result.content, '{"tag":"original"}');
});

test('覆盖写入失败时保留原文件内容', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ea-ow-'));
  try {
    const target = path.join(root, 'keep.txt');
    await writeFile(target, 'preserve-me', 'utf8');
    const realRename = fs.rename.bind(fs);
    let renamed = false;
    fs.rename = (async () => {
      renamed = true;
      throw new Error('simulated rename failure');
    }) as typeof fs.rename;
    try {
      await assert.rejects(
        () => writeFileOverwrite(target, 'new-content', root),
        /simulated rename failure/,
      );
      assert.equal(renamed, true);
      assert.equal(await readFile(target, 'utf8'), 'preserve-me');
    } finally {
      fs.rename = realRename;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
