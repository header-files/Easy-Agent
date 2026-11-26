import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  PersistenceError,
  assertDurableJsonValue,
  indexJournal,
  openPersistenceRuntime,
  readJsonlFile,
  resolveLayout,
  rollForward,
  sessionEventsPath,
  stableStringify,
  TransactionJournal,
  writeAllOperations,
  type CommittedMarker,
  type PreparedTransaction,
} from '../src/runtime/persistence/index.ts';

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'ea-persist-'));
}

test('JSONL 尾部截断可修复；中间损坏 fail closed', async () => {
  const root = await tempRoot();
  try {
    const file = path.join(root, 'sample.jsonl');
    await writeFile(
      file,
      `${JSON.stringify({ id: 'a', sequence: 1, transactionId: 't', type: 'x', payload: {}, timestamp: 't', schemaVersion: 1 })}\n{broken`,
      'utf8',
    );
    const { records, truncatedTail } = await readJsonlFile(file, (value) => {
      const record = value as { id: string };
      if (typeof record.id !== 'string') throw new Error('bad');
      return record;
    });
    assert.equal(truncatedTail, true);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.id, 'a');

    await writeFile(
      file,
      `${JSON.stringify({ id: 'a', sequence: 1, transactionId: 't', type: 'x', payload: {}, timestamp: 't', schemaVersion: 1 })}\nnot-json\n${JSON.stringify({ id: 'b', sequence: 2, transactionId: 't', type: 'x', payload: {}, timestamp: 't', schemaVersion: 1 })}\n`,
      'utf8',
    );
    await assert.rejects(
      () =>
        readJsonlFile(file, (value) => {
          const record = value as { id: string };
          if (typeof record.id !== 'string') throw new Error('bad');
          return record;
        }),
      (error: unknown) =>
        error instanceof PersistenceError && error.code === 'corrupt_store',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('同 Session FIFO 提交；未 COMMITTED 对 Projection 不可见', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    try {
      const registered = await runtime.commitWorkspaceRecords([
        {
          type: 'workspace/registered',
          payload: {
            workspaceId: 'w1',
            name: 'w1',
            rootPath: root,
          },
        },
      ]);
      assert.equal(registered.status, 'committed');
      const outcome = await runtime.commitSessionEvents('s1', [
        {
          type: 'session/created',
          payload: { model: 'local/m', workspaceId: 'w1' },
        },
        {
          type: 'user/message',
          payload: { content: 'hi' },
          executionId: 'e1',
        },
      ]);
      assert.equal(outcome.status, 'committed');
      await runtime.refreshProjections();
      assert.equal(runtime.projections.sessions.get('s1')?.model, 'local/m');

      // Simulate PREPARED+ops without COMMITTED: projection filter hides them.
      const layout = resolveLayout(root);
      const journal = new TransactionJournal(layout);
      const prepared = await journal.appendPrepared([
        {
          operationId: 'op-hidden',
          target: 'session_events',
          sessionId: 's1',
          record: {
            id: 'evt-hidden',
            sessionId: 's1',
            sequence: 99,
            transactionId: 'tx-hidden',
            type: 'session/model_changed',
            payload: { model: 'should-not-see' },
            timestamp: new Date().toISOString(),
            schemaVersion: 1,
          },
        },
      ]);
      await writeAllOperations(layout, prepared.operations);
      await runtime.refreshProjections();
      assert.notEqual(
        runtime.projections.sessions.get('s1')?.model,
        'should-not-see',
      );
    } finally {
      await runtime.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Roll Forward：PREPARED 后崩溃可补写 COMMITTED 且幂等', async () => {
  const root = await tempRoot();
  try {
    const layout = resolveLayout(root);
    const journal = new TransactionJournal(layout);
    const prepared = await journal.appendPrepared([
      {
        operationId: 'op1',
        target: 'session_events',
        sessionId: 's2',
        record: {
          id: 'evt1',
          sessionId: 's2',
          sequence: 1,
          transactionId: 'placeholder',
          type: 'session/created',
          payload: { model: 'm' },
          timestamp: new Date().toISOString(),
          schemaVersion: 1,
        },
      },
    ]);
    await writeAllOperations(layout, prepared.operations);

    const first = await rollForward(layout, journal);
    assert.ok(first.rolledForward.includes(prepared.transactionId));
    const second = await rollForward(layout, journal);
    assert.equal(second.rolledForward.length, 0);

    const runtime = await openPersistenceRuntime(root);
    try {
      assert.equal(runtime.projections.sessions.get('s2')?.model, 'm');
    } finally {
      await runtime.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('数据目录写锁互斥', async () => {
  const root = await tempRoot();
  try {
    const first = await openPersistenceRuntime(root);
    await assert.rejects(
      () => openPersistenceRuntime(root),
      (error: unknown) =>
        error instanceof PersistenceError && error.code === 'lock_failed',
    );
    await first.dispose();
    const second = await openPersistenceRuntime(root);
    await second.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Workspace Registry 与 UNSAFE 冷启动保留', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    try {
      const reg = await runtime.commitWorkspaceRecords([
        {
          type: 'workspace/registered',
          payload: {
            workspaceId: 'w1',
            name: 'ws',
            rootPath: '/tmp/ws',
          },
        },
        {
          type: 'workspace/terminal_intent',
          payload: { workspaceId: 'w1', activityId: 'act-1' },
        },
      ]);
      assert.equal(reg.status, 'committed');
      await runtime.refreshProjections();
      assert.equal(runtime.projections.workspaces.get('w1')?.safety, 'UNSAFE');
    } finally {
      await runtime.dispose();
    }
    const again = await openPersistenceRuntime(root);
    try {
      assert.equal(again.projections.workspaces.get('w1')?.safety, 'UNSAFE');
      const recovered = await again.commitWorkspaceRecords([
        {
          type: 'workspace/recovered',
          payload: {
            workspaceId: 'w1',
            coveredActivityIds: ['act-1'],
          },
        },
      ]);
      assert.equal(recovered.status, 'committed');
      await again.refreshProjections();
      assert.equal(again.projections.workspaces.get('w1')?.safety, 'NORMAL');
    } finally {
      await again.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('PREPARED Operation 与事务 ID 不一致时拒绝可写启动', async () => {
  const root = await tempRoot();
  try {
    const layout = resolveLayout(root);
    await mkdir(layout.journalDir, { recursive: true });
    const prepared = {
      transactionId: 'tx-one',
      state: 'PREPARED',
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      operations: [
        {
          operationId: 'op1',
          target: 'session_events',
          sessionId: 's-mismatch',
          record: {
            id: 'evt1',
            sessionId: 's-mismatch',
            sequence: 1,
            transactionId: 'tx-other',
            type: 'session/created',
            payload: { model: 'm' },
            timestamp: new Date().toISOString(),
            schemaVersion: 1,
          },
        },
      ],
    };
    await writeFile(
      layout.journalFile,
      `${JSON.stringify(prepared)}\n`,
      'utf8',
    );
    await assert.rejects(
      () => openPersistenceRuntime(root),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === 'corrupt_store' &&
        error.message.includes('tx-other'),
    );
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('Session 引用缺失 Workspace 时拒绝可写启动', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    const outcome = await runtime.commitSessionEvents('s-dangling', [
      {
        type: 'session/created',
        payload: { model: 'm', workspaceId: 'ws-missing' },
      },
    ]);
    assert.equal(outcome.status, 'committed');
    await runtime.dispose();

    await assert.rejects(
      () => openPersistenceRuntime(root),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === 'corrupt_store' &&
        error.message.includes('ws-missing'),
    );
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('COMMITTED 事务缺少目标记录时拒绝可写启动', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    const outcome = await runtime.commitSessionEvents('s-missing', [
      { type: 'session/created', payload: { model: 'm' } },
    ]);
    assert.equal(outcome.status, 'committed');
    await runtime.dispose();

    await unlink(sessionEventsPath(resolveLayout(root), 's-missing'));

    await assert.rejects(
      () => openPersistenceRuntime(root),
      (error: unknown) =>
        error instanceof PersistenceError && error.code === 'corrupt_store',
    );
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

test('Session 目标写入不确定后仅冻结该 Session', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    try {
      const first = await runtime.commitSessionEvents('s-freeze', [
        { type: 'session/created', payload: { model: 'm' } },
      ]);
      assert.equal(first.status, 'committed');

      const uncertain = await runtime.coordinator.commitSessionEvents(
        's-freeze',
        [{ type: 'session/model_changed', payload: { model: 'm2' } }],
        { failBeforeSyncIfPathIncludes: `${path.sep}sessions${path.sep}` },
      );
      assert.equal(uncertain.status, 'commit_uncertain');
      assert.equal(runtime.coordinator.isScopeFrozen('s-freeze'), true);
      assert.equal(runtime.coordinator.isJournalFrozen(), false);

      const blocked = await runtime.commitSessionEvents('s-freeze', [
        {
          type: 'user/message',
          payload: { content: 'nope' },
          executionId: 'e',
        },
      ]);
      assert.equal(blocked.status, 'commit_uncertain');
      assert.equal(blocked.error.code, 'unavailable');

      const other = await runtime.commitSessionEvents('s-other', [
        { type: 'session/created', payload: { model: 'ok' } },
      ]);
      assert.equal(other.status, 'committed');
    } finally {
      await runtime.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('全局 Journal 故障冻结所有 Session 新事务', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    try {
      const first = await runtime.commitSessionEvents('s1', [
        { type: 'session/created', payload: { model: 'm' } },
      ]);
      assert.equal(first.status, 'committed');

      const uncertain = await runtime.coordinator.commitSessionEvents(
        's1',
        [{ type: 'session/model_changed', payload: { model: 'm2' } }],
        { failBeforeSyncIfLineIncludes: '"state":"COMMITTED"' },
      );
      assert.equal(uncertain.status, 'commit_uncertain');
      assert.equal(runtime.coordinator.isJournalFrozen(), true);

      const s1Blocked = await runtime.commitSessionEvents('s1', [
        {
          type: 'user/message',
          payload: { content: 'nope' },
          executionId: 'e1',
        },
      ]);
      assert.equal(s1Blocked.status, 'commit_uncertain');
      assert.equal(s1Blocked.error.code, 'unavailable');

      const s2Blocked = await runtime.commitSessionEvents('s2', [
        { type: 'session/created', payload: { model: 'other' } },
      ]);
      assert.equal(s2Blocked.status, 'commit_uncertain');
      assert.equal(s2Blocked.error.code, 'unavailable');
    } finally {
      await runtime.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function samplePrepared(transactionId: string): PreparedTransaction {
  return {
    transactionId,
    state: 'PREPARED',
    schemaVersion: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    operations: [
      {
        operationId: 'op1',
        target: 'session_events',
        sessionId: 's',
        record: {
          id: 'e1',
          sessionId: 's',
          sequence: 1,
          transactionId,
          type: 'session/created',
          payload: { model: 'm' },
          timestamp: '2026-01-01T00:00:00.000Z',
          schemaVersion: 1,
        },
      },
    ],
  };
}

function sampleCommitted(
  transactionId: string,
  committedAt = '2026-01-01T00:00:01.000Z',
): CommittedMarker {
  return {
    transactionId,
    state: 'COMMITTED',
    schemaVersion: 1,
    committedAt,
  };
}

test('stableStringify 拒绝非 JSON 无损值', () => {
  assert.equal(stableStringify({ a: 1, b: 'x' }), '{"a":1,"b":"x"}');
  assert.throws(
    () => stableStringify({ when: new Date('2024-01-01T00:00:00.000Z') }),
    (error: unknown) =>
      error instanceof PersistenceError && error.code === 'invalid_record',
  );
  assert.throws(
    () => stableStringify({ bag: new Map([['k', 1]]) }),
    (error: unknown) =>
      error instanceof PersistenceError && error.code === 'invalid_record',
  );
  assert.throws(
    () => assertDurableJsonValue({ n: Number.NaN }),
    (error: unknown) =>
      error instanceof PersistenceError && error.code === 'invalid_record',
  );
});

test('indexJournal 拒绝 COMMITTED 先于 PREPARED', () => {
  const prepared = samplePrepared('tx-order');
  const committed = sampleCommitted('tx-order');
  assert.throws(
    () => indexJournal([committed, prepared]),
    (error: unknown) =>
      error instanceof PersistenceError &&
      error.code === 'corrupt_store' &&
      error.message.includes('before its PREPARED'),
  );
});

test('indexJournal 拒绝内容不同的重复 COMMITTED', () => {
  const prepared = samplePrepared('tx-dup');
  const first = sampleCommitted('tx-dup', '2026-01-01T00:00:01.000Z');
  const second = sampleCommitted('tx-dup', '2026-01-01T00:00:02.000Z');
  assert.throws(
    () => indexJournal([prepared, first, second]),
    (error: unknown) =>
      error instanceof PersistenceError && error.code === 'conflict',
  );
});

test('indexJournal 拒绝同内容重复 COMMITTED', () => {
  const prepared = samplePrepared('tx-same');
  const marker = sampleCommitted('tx-same');
  assert.throws(
    () => indexJournal([prepared, marker, structuredClone(marker)]),
    (error: unknown) =>
      error instanceof PersistenceError &&
      error.code === 'corrupt_store' &&
      error.message.includes('Duplicate COMMITTED'),
  );
});

test('异常 Journal 顺序拒绝可写启动', async () => {
  const root = await tempRoot();
  try {
    const runtime = await openPersistenceRuntime(root);
    const outcome = await runtime.commitSessionEvents('s-order', [
      { type: 'session/created', payload: { model: 'm' } },
    ]);
    assert.equal(outcome.status, 'committed');
    await runtime.dispose();

    const layout = resolveLayout(root);
    const { readFile, writeFile } = await import('node:fs/promises');
    const raw = await readFile(layout.journalFile, 'utf8');
    const lines = raw.split('\n').filter((line) => line.length > 0);
    assert.ok(lines.length >= 2);
    // Swap so COMMITTED appears before PREPARED for the same transaction.
    const swapped = [lines[1]!, lines[0]!, ...lines.slice(2)].join('\n') + '\n';
    await writeFile(layout.journalFile, swapped, 'utf8');

    await assert.rejects(
      () => openPersistenceRuntime(root),
      (error: unknown) =>
        error instanceof PersistenceError && error.code === 'corrupt_store',
    );
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});
