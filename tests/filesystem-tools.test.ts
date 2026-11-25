import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { redactCommandForDisplay } from '../src/application/cli/render-execution.ts';
import { ApprovalService } from '../src/runtime/approval/index.ts';
import {
  DefaultToolRegistry,
  GuardedToolExecutor,
  registerBuiltinTools,
} from '../src/runtime/tool/index.ts';
import {
  WorkspaceAccessCoordinator,
  WorkspaceManager,
  WorkspacePathResolver,
  WorkspaceError,
} from '../src/runtime/workspace/index.ts';

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'ea-fs-'));
  const coordinator = new WorkspaceAccessCoordinator();
  const manager = new WorkspaceManager({ coordinator });
  const workspace = await manager.register('ws', root);
  const registry = new DefaultToolRegistry();
  const approval = new ApprovalService();
  approval.subscribe((request) => {
    if (request.status === 'PENDING') approval.decide(request.id, 'approve');
  });
  registerBuiltinTools(registry, { manager, coordinator });
  const executor = new GuardedToolExecutor(registry, {
    approval,
    coordinator,
  });
  return { root, workspace, executor, manager };
}

test('list/read/write/edit 与默认不覆盖、精确编辑失败保持原文件', async () => {
  const { root, workspace, executor } = await setup();
  try {
    await writeFile(path.join(root, 'note.md'), 'hello world', 'utf8');
    const listed = await executor.execute(
      {
        id: '1',
        name: 'list_directory',
        argumentsJson: JSON.stringify({ path: '.' }),
      },
      { workspaceId: workspace.id, executionId: 'e1' },
    );
    assert.equal(listed.status, 'success');
    assert.match(listed.content, /note\.md/);

    const read = await executor.execute(
      {
        id: '2',
        name: 'read_file',
        argumentsJson: JSON.stringify({ path: 'note.md' }),
      },
      { workspaceId: workspace.id, executionId: 'e1' },
    );
    assert.equal(read.content, 'hello world');

    const blocked = await executor.execute(
      {
        id: '3',
        name: 'write_file',
        argumentsJson: JSON.stringify({
          path: 'note.md',
          content: 'nope',
        }),
      },
      { workspaceId: workspace.id, executionId: 'e1' },
    );
    assert.equal(blocked.status, 'error');
    assert.equal(
      await readFile(path.join(root, 'note.md'), 'utf8'),
      'hello world',
    );

    const written = await executor.execute(
      {
        id: '4',
        name: 'write_file',
        argumentsJson: JSON.stringify({
          path: 'note.md',
          content: 'alpha alpha',
          overwrite: true,
        }),
      },
      { workspaceId: workspace.id, executionId: 'e1' },
    );
    assert.equal(written.status, 'success');

    const multi = await executor.execute(
      {
        id: '5',
        name: 'edit_file',
        argumentsJson: JSON.stringify({
          path: 'note.md',
          oldText: 'alpha',
          newText: 'beta',
        }),
      },
      { workspaceId: workspace.id, executionId: 'e1' },
    );
    assert.equal(multi.status, 'error');
    assert.equal(
      await readFile(path.join(root, 'note.md'), 'utf8'),
      'alpha alpha',
    );

    await writeFile(path.join(root, 'note.md'), 'only once', 'utf8');
    const edited = await executor.execute(
      {
        id: '6',
        name: 'edit_file',
        argumentsJson: JSON.stringify({
          path: 'note.md',
          oldText: 'once',
          newText: 'twice',
        }),
      },
      { workspaceId: workspace.id, executionId: 'e1' },
    );
    assert.equal(edited.status, 'success');
    assert.equal(
      await readFile(path.join(root, 'note.md'), 'utf8'),
      'only twice',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('路径穿越与符号链接访问被拒绝', async () => {
  const { root, workspace, executor } = await setup();
  try {
    const outside = await mkdtemp(path.join(tmpdir(), 'ea-out-'));
    try {
      await writeFile(path.join(outside, 'secret.txt'), 'secret', 'utf8');
      const escape = await executor.execute(
        {
          id: '1',
          name: 'read_file',
          argumentsJson: JSON.stringify({
            path: path.relative(root, path.join(outside, 'secret.txt')),
          }),
        },
        { workspaceId: workspace.id, executionId: 'e1' },
      );
      assert.equal(escape.status, 'error');

      const link = path.join(root, 'link.txt');
      try {
        await symlink(path.join(outside, 'secret.txt'), link);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
        throw error;
      }
      const viaLink = await executor.execute(
        {
          id: '2',
          name: 'read_file',
          argumentsJson: JSON.stringify({ path: 'link.txt' }),
        },
        { workspaceId: workspace.id, executionId: 'e1' },
      );
      assert.equal(viaLink.status, 'error');

      const resolver = new WorkspacePathResolver(workspace.rootPath);
      await assert.rejects(
        () => resolver.resolve('../nope'),
        (error: unknown) =>
          error instanceof WorkspaceError && error.code === 'invalid_path',
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('write_file 无 overwrite 时用 O_EXCL，已存在文件不会被覆盖', async () => {
  const { root, workspace, executor } = await setup();
  try {
    await writeFile(path.join(root, 'exist.txt'), 'keep-me', 'utf8');
    const denied = await executor.execute(
      {
        id: '1',
        name: 'write_file',
        argumentsJson: JSON.stringify({
          path: 'exist.txt',
          content: 'replaced',
        }),
      },
      { workspaceId: workspace.id, executionId: 'e1' },
    );
    assert.equal(denied.status, 'error');
    assert.equal(
      await readFile(path.join(root, 'exist.txt'), 'utf8'),
      'keep-me',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('list_directory：readdir 间隙目录被换成区外符号链接时失败关闭', async () => {
  const { root, workspace, executor } = await setup();
  const outside = await mkdtemp(path.join(tmpdir(), 'ea-list-out-'));
  try {
    // Workspace root may be realpath'd (/private/var vs /var on macOS).
    const wsRoot = workspace.rootPath;
    const inner = path.join(wsRoot, 'inner');
    await mkdir(inner);
    await writeFile(path.join(inner, 'inside.txt'), 'in', 'utf8');
    await writeFile(path.join(outside, 'outside.txt'), 'secret', 'utf8');
    const innerReal = await fs.realpath(inner);

    const realReaddir = fs.readdir.bind(fs);
    fs.readdir = (async (dirPath: Parameters<typeof fs.readdir>[0]) => {
      const resolved = await fs
        .realpath(String(dirPath))
        .catch(() => path.resolve(String(dirPath)));
      if (resolved === innerReal) {
        await rename(inner, path.join(wsRoot, 'inner.bak'));
        await symlink(outside, inner);
      }
      return realReaddir(dirPath);
    }) as typeof fs.readdir;

    try {
      const listed = await executor.execute(
        {
          id: '1',
          name: 'list_directory',
          argumentsJson: JSON.stringify({ path: 'inner' }),
        },
        { workspaceId: workspace.id, executionId: 'e1' },
      );
      assert.equal(listed.status, 'error');
      assert.equal(listed.content.includes('outside.txt'), false);
      assert.equal(listed.content.includes('secret'), false);
    } finally {
      fs.readdir = realReaddir;
    }
  } finally {
    await rm(outside, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('审批 command 展示：常见令牌口令模式脱敏，结构仍可审阅', () => {
  const sample =
    'curl -H "Authorization: Bearer tok_live_abc" https://x -password=secret123';
  const shown = redactCommandForDisplay(sample);
  assert.equal(shown.redacted, true);
  assert.match(shown.text, /Authorization: Bearer <redacted>/i);
  assert.match(shown.text, /password=<redacted>/i);
  assert.equal(shown.text.includes('tok_live_abc'), false);
  assert.equal(shown.text.includes('secret123'), false);
  assert.match(shown.text, /curl/);
  assert.match(shown.text, /https:\/\/x/);
});

test('审批 command 脱敏不得吞掉后续 Shell 命令', () => {
  const spaced = 'curl -H Authorization:Bearer abc && rm -rf report';
  const spacedShown = redactCommandForDisplay(spaced);
  assert.equal(spacedShown.redacted, true);
  assert.match(spacedShown.text, /Authorization:\s*(Bearer )?<redacted>/i);
  assert.equal(spacedShown.text.includes('abc'), false);
  assert.match(spacedShown.text, /&&\s*rm -rf report/);

  for (const [sample, expectTail] of [
    ['curl -H Authorization:Bearer abc&&rm -rf report', /&&rm -rf report/],
    [
      'curl -H Authorization:Bearer abc;touch changed.txt',
      /;touch changed\.txt/,
    ],
    ['curl -H Authorization:Bearer abc|sh', /\|sh/],
  ] as const) {
    const shown = redactCommandForDisplay(sample);
    assert.equal(shown.redacted, true, sample);
    assert.equal(shown.text.includes('abc'), false, sample);
    assert.match(shown.text, expectTail, sample);
  }
});
