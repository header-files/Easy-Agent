import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  WorkspaceAccessCoordinator,
  WorkspaceError,
  WorkspaceManager,
  rootsOverlap,
} from '../src/runtime/workspace/index.ts';

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

test('注册已有目录、创建新目录、默认 Workspace 与 Session 引用删除保护', async () => {
  const root = await tempDir('ea-ws-');
  try {
    const existing = path.join(root, 'existing');
    await mkdir(existing);
    const coordinator = new WorkspaceAccessCoordinator();
    const manager = new WorkspaceManager({ coordinator });
    const registered = await manager.register('docs', existing);
    assert.equal(manager.getDefault()?.id, registered.id);
    const createdPath = path.join(root, 'fresh');
    const created = await manager.create('code', createdPath);
    assert.notEqual(created.id, registered.id);
    assert.equal(manager.list().length, 2);
    assert.equal(manager.bindSession(registered.id, 's1'), true);
    assert.throws(
      () => manager.remove(registered.id),
      (error: unknown) => {
        assert.ok(error instanceof WorkspaceError);
        assert.equal(error.code, 'in_use');
        return true;
      },
    );
    manager.unbindSession(registered.id, 's1');
    assert.equal(manager.remove(registered.id), true);
    assert.equal(manager.get(registered.id), undefined);
    assert.equal(manager.getDefault()?.id, created.id);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('拒绝重复或嵌套 Workspace 根路径与非目录注册', async () => {
  const root = await tempDir('ea-ws-overlap-');
  try {
    const a = path.join(root, 'a');
    const nested = path.join(a, 'nested');
    await mkdir(nested, { recursive: true });
    const manager = new WorkspaceManager();
    await manager.register('a', a);
    await assert.rejects(
      () => manager.register('nested', nested),
      (error: unknown) =>
        error instanceof WorkspaceError && error.code === 'overlap',
    );
    await assert.rejects(
      () => manager.register('again', a),
      (error: unknown) =>
        error instanceof WorkspaceError && error.code === 'overlap',
    );
    const file = path.join(root, 'file.txt');
    await writeFile(file, 'x');
    await assert.rejects(
      () => manager.register('file', file),
      (error: unknown) =>
        error instanceof WorkspaceError && error.code === 'not_directory',
    );
    assert.equal(rootsOverlap(a, nested), true);
    assert.equal(rootsOverlap(a, path.join(root, 'b')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('读共享、写互斥、写优先与排队取消', async () => {
  const coordinator = new WorkspaceAccessCoordinator();
  const id = 'ws-1';
  const events: string[] = [];
  let releaseRead!: () => void;
  const reading = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });

  const firstRead = coordinator.run({
    workspaceId: id,
    access: 'read',
    task: async () => {
      events.push('read1-start');
      await reading;
      events.push('read1-end');
      return 'r1';
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  let releaseWrite!: () => void;
  const writing = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const write = coordinator.run({
    workspaceId: id,
    access: 'write',
    task: async () => {
      events.push('write-start');
      await writing;
      events.push('write-end');
      return 'w';
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const secondRead = coordinator.run({
    workspaceId: id,
    access: 'read',
    task: async () => {
      events.push('read2');
      return 'r2';
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  releaseRead();
  assert.equal(await firstRead, 'r1');
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.includes('write-start'));
  assert.ok(!events.includes('read2'));
  releaseWrite();
  assert.equal(await write, 'w');
  assert.equal(await secondRead, 'r2');
  assert.deepEqual(
    events.filter((item) => item === 'read2' || item.startsWith('write')),
    ['write-start', 'write-end', 'read2'],
  );

  const controller = new AbortController();
  const blocked = coordinator.run({
    workspaceId: id,
    access: 'write',
    task: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return 'holder';
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const cancelled = coordinator.run({
    workspaceId: id,
    access: 'read',
    signal: controller.signal,
    task: async () => 'nope',
  });
  controller.abort();
  await assert.rejects(
    cancelled,
    (error: unknown) =>
      error instanceof WorkspaceError && error.code === 'cancelled',
  );
  await blocked;
});

test('UNSAFE 阻断读写，显式恢复后可继续；标记时拒绝排队者', async () => {
  const coordinator = new WorkspaceAccessCoordinator();
  const id = 'ws-unsafe';
  const writer = coordinator.run({
    workspaceId: id,
    access: 'write',
    task: async () => {
      coordinator.markUnsafe(id);
      return 'done';
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const queued = coordinator.run({
    workspaceId: id,
    access: 'read',
    task: async () => 'queued',
  });
  await writer;
  await assert.rejects(
    queued,
    (error: unknown) =>
      error instanceof WorkspaceError && error.code === 'unsafe',
  );
  await assert.rejects(
    () =>
      coordinator.run({
        workspaceId: id,
        access: 'read',
        task: async () => 'blocked',
      }),
    (error: unknown) =>
      error instanceof WorkspaceError && error.code === 'unsafe',
  );
  coordinator.recover(id);
  assert.equal(
    await coordinator.run({
      workspaceId: id,
      access: 'read',
      task: async () => 'ok',
    }),
    'ok',
  );
});

test('经符号链接注册时固定到物理根，并与直接注册判重叠', async () => {
  const root = await tempDir('ea-ws-link-');
  try {
    const real = path.join(root, 'real');
    await mkdir(real);
    const link = path.join(root, 'link');
    try {
      await symlink(real, link, 'dir');
    } catch (error) {
      // Some environments lack permission to create directory symlinks.
      if (
        process.platform === 'win32' ||
        (error as NodeJS.ErrnoException).code === 'EPERM'
      ) {
        return;
      }
      throw error;
    }
    const manager = new WorkspaceManager();
    const viaLink = await manager.register('linked', link);
    assert.equal(viaLink.rootPath, await realpath(real));
    await assert.rejects(
      () => manager.register('direct', real),
      (error: unknown) =>
        error instanceof WorkspaceError && error.code === 'overlap',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
