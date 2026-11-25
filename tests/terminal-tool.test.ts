import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ApprovalService } from '../src/runtime/approval/index.ts';
import {
  DefaultToolRegistry,
  GuardedToolExecutor,
  TerminalExecutor,
  registerBuiltinTools,
} from '../src/runtime/tool/index.ts';
import {
  WorkspaceAccessCoordinator,
  WorkspaceManager,
} from '../src/runtime/workspace/index.ts';

test('terminal 执行原生 Shell 命令并返回退出码与输出', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ea-term-'));
  try {
    const coordinator = new WorkspaceAccessCoordinator();
    const manager = new WorkspaceManager({ coordinator });
    const workspace = await manager.register('ws', root);
    const registry = new DefaultToolRegistry();
    const approval = new ApprovalService();
    approval.subscribe((request) => {
      if (request.status === 'PENDING') approval.decide(request.id, 'approve');
    });
    const terminal = new TerminalExecutor();
    registerBuiltinTools(registry, { manager, coordinator, terminal });
    const executor = new GuardedToolExecutor(registry, {
      approval,
      coordinator,
    });
    const command =
      process.platform === 'win32'
        ? 'echo hello& exit /b 7'
        : 'echo hello; exit 7';
    const result = await executor.execute(
      {
        id: '1',
        name: 'terminal',
        argumentsJson: JSON.stringify({ command }),
      },
      { workspaceId: workspace.id, executionId: 'e1' },
    );
    assert.equal(result.status, 'success');
    const body = JSON.parse(result.content) as {
      exitCode: number;
      stdout: string;
    };
    assert.equal(body.exitCode, 7);
    assert.match(body.stdout, /hello/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('清理不确定时先 UNSAFE 再阻断后续工具', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ea-term-unsafe-'));
  try {
    const coordinator = new WorkspaceAccessCoordinator();
    const manager = new WorkspaceManager({ coordinator });
    const workspace = await manager.register('ws', root);
    const registry = new DefaultToolRegistry();
    const approval = new ApprovalService();
    approval.subscribe((request) => {
      if (request.status === 'PENDING') approval.decide(request.id, 'approve');
    });
    const terminal = new TerminalExecutor();
    const original = terminal.run.bind(terminal);
    terminal.run = async (request) => {
      request.onCleanupUncertain?.();
      request.forceCleanupUncertain = true;
      return original({
        ...request,
        command: process.platform === 'win32' ? 'echo x' : 'echo x',
        forceCleanupUncertain: true,
      });
    };
    registerBuiltinTools(registry, { manager, coordinator, terminal });
    const executor = new GuardedToolExecutor(registry, {
      approval,
      coordinator,
    });
    // Force uncertain path via direct executor API used by tool.
    const direct = new TerminalExecutor();
    await assert.rejects(
      () =>
        direct.run({
          command: process.platform === 'win32' ? 'echo x' : 'echo x',
          cwd: root,
          forceCleanupUncertain: true,
          onCleanupUncertain: () => coordinator.markUnsafe(workspace.id),
        }),
      (error: unknown) =>
        error instanceof Error &&
        /cleanup could not be confirmed/i.test(error.message),
    );
    assert.equal(coordinator.safety(workspace.id), 'UNSAFE');
    const blocked = await executor.execute(
      {
        id: '1',
        name: 'list_directory',
        argumentsJson: JSON.stringify({ path: '.' }),
      },
      { workspaceId: workspace.id, executionId: 'e1' },
    );
    assert.equal(blocked.status, 'error');
    assert.match(blocked.content, /unsafe/i);
    coordinator.recover(workspace.id);
    const ok = await executor.execute(
      {
        id: '2',
        name: 'list_directory',
        argumentsJson: JSON.stringify({ path: '.' }),
      },
      { workspaceId: workspace.id, executionId: 'e2' },
    );
    assert.equal(ok.status, 'success');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'Shell 退出后仍等待进程组内后台任务结束再返回',
  { skip: process.platform === 'win32' ? 'POSIX process-group wait' : false },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ea-term-bg-'));
    try {
      const marker = path.join(root, 'marker');
      const terminal = new TerminalExecutor({ descendantPollMs: 20 });
      const started = performance.now();
      const result = await terminal.run({
        command: `(sleep 1; echo later > marker) &`,
        cwd: root,
      });
      const elapsed = performance.now() - started;
      assert.equal(result.timedOut, false);
      assert.equal(result.cancelled, false);
      assert.ok(
        elapsed >= 800,
        `expected to wait for background job, elapsed=${elapsed}`,
      );
      await access(marker);
      assert.match(await readFile(marker, 'utf8'), /later/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  '后台任务未在 timeoutMs 内结束时终止进程组',
  { skip: process.platform === 'win32' ? 'POSIX process-group wait' : false },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ea-term-bg-to-'));
    try {
      const terminal = new TerminalExecutor({
        descendantPollMs: 20,
        killGraceMs: 200,
      });
      const result = await terminal.run({
        command: `(sleep 30; echo late > marker) &`,
        cwd: root,
        timeoutMs: 300,
      });
      assert.equal(result.timedOut, true);
      await assert.rejects(() => access(path.join(root, 'marker')));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
