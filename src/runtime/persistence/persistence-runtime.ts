import { PersistenceError } from './errors.ts';
import { ensureDir, type DurableFsHooks } from './durable-fs.ts';
import { TransactionJournal } from './journal.ts';
import { WorkspaceLifecycleCoordinator } from './lifecycle-coordinator.ts';
import { parseSessionEvent, parseWorkspaceRecord } from './operation-writer.ts';
import { readJsonlFile } from './jsonl-store.ts';
import {
  resolveLayout,
  sessionEventsPath,
  type PersistenceLayout,
} from './paths.ts';
import { replayProjections, type ProjectionState } from './projections.ts';
import { rollForward } from './recovery.ts';
import { SessionWriteCoordinator } from './session-write-coordinator.ts';
import { acquireWriteLock, type WriteLock } from './write-lock.ts';
import type {
  SessionEventDraft,
  WorkspaceRecordDraft,
} from './session-write-coordinator.ts';
import type { CommitOutcome } from './session-write-coordinator.ts';

export interface PersistenceRuntime {
  readonly layout: PersistenceLayout;
  readonly coordinator: SessionWriteCoordinator;
  readonly lifecycle: WorkspaceLifecycleCoordinator;
  readonly projections: ProjectionState;
  commitSessionEvents(
    sessionId: string,
    drafts: readonly SessionEventDraft[],
    hooks?: DurableFsHooks,
  ): Promise<CommitOutcome>;
  commitWorkspaceRecords(
    drafts: readonly WorkspaceRecordDraft[],
    hooks?: DurableFsHooks,
  ): Promise<CommitOutcome>;
  refreshProjections(): Promise<ProjectionState>;
  dispose(): Promise<void>;
}

/**
 * Open data directory: exclusive lock → ensure layout → roll forward → replay.
 * Fail closed on corrupt stores.
 */
export async function openPersistenceRuntime(
  dataRoot: string,
): Promise<PersistenceRuntime> {
  const layout = resolveLayout(dataRoot);
  await ensureDir(layout.root);
  await ensureDir(layout.journalDir);
  await ensureDir(layout.sessionsDir);
  await ensureDir(layout.workspacesDir);

  let lock: WriteLock;
  try {
    lock = await acquireWriteLock(layout);
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError('lock_failed');
  }

  try {
    const journal = new TransactionJournal(layout);
    const recovery = await rollForward(layout, journal);
    const coordinator = new SessionWriteCoordinator(layout, journal);
    for (const id of recovery.committedTransactionIds) {
      coordinator.markCommitted(id);
    }
    await seedSequences(layout, coordinator, recovery.committedTransactionIds);
    const projections = await replayProjections(
      layout,
      recovery.committedTransactionIds,
      { interruptUnfinished: true },
    );
    // Cold-start interrupt upgrades must survive later refreshProjections
    // (e.g. Bootstrap registering a default Workspace) until interrupted_detected
    // is durably committed and visible in replay.
    const coldInterruptPending = new Set<string>();
    for (const execution of projections.executions.values()) {
      if (execution.needsInterruptPersist) {
        coldInterruptPending.add(execution.executionId);
      }
    }
    const lifecycle = new WorkspaceLifecycleCoordinator();
    // Serialize refreshes so an earlier in-flight replay cannot overwrite a
    // newer commit's projection (cross-Session commits run concurrently).
    let refreshTail: Promise<unknown> = Promise.resolve();

    const applyProjectionState = (next: ProjectionState): void => {
      projections.sessions.clear();
      for (const [k, v] of next.sessions) projections.sessions.set(k, v);
      projections.executions.clear();
      for (const [k, v] of next.executions) projections.executions.set(k, v);
      projections.messagesBySession.clear();
      for (const [k, v] of next.messagesBySession)
        projections.messagesBySession.set(k, v);
      projections.workspaces.clear();
      for (const [k, v] of next.workspaces) projections.workspaces.set(k, v);
      projections.workspaceSessionRefs.clear();
      for (const [k, v] of next.workspaceSessionRefs)
        projections.workspaceSessionRefs.set(k, v);
    };

    const reapplyColdInterrupts = (state: ProjectionState): void => {
      for (const executionId of [...coldInterruptPending]) {
        const execution = state.executions.get(executionId);
        if (!execution) {
          coldInterruptPending.delete(executionId);
          continue;
        }
        if (
          execution.status === 'COMPLETED' ||
          execution.status === 'FAILED' ||
          execution.status === 'CANCELLED'
        ) {
          coldInterruptPending.delete(executionId);
          continue;
        }
        if (
          execution.status === 'INTERRUPTED' &&
          execution.interrupted === true &&
          execution.needsInterruptPersist !== true
        ) {
          // Durable interrupted_detected already replayed.
          coldInterruptPending.delete(executionId);
          continue;
        }
        execution.status = 'INTERRUPTED';
        execution.interrupted = true;
        execution.needsInterruptPersist = true;
      }
    };

    return {
      layout,
      coordinator,
      lifecycle,
      projections,
      commitSessionEvents: (sessionId, drafts, hooks) =>
        coordinator.commitSessionEvents(sessionId, drafts, hooks),
      commitWorkspaceRecords: (drafts, hooks) =>
        coordinator.commitWorkspaceRecords(drafts, hooks),
      async refreshProjections() {
        const run = refreshTail.then(async () => {
          const latest = await journal.readAll();
          const committed = new Set(
            latest.records
              .filter((item) => item.state === 'COMMITTED')
              .map((item) => item.transactionId),
          );
          const next = await replayProjections(layout, committed);
          reapplyColdInterrupts(next);
          applyProjectionState(next);
          return projections;
        });
        // Keep the queue moving even when a refresh fails.
        refreshTail = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
      async dispose() {
        await lock.release();
      },
    };
  } catch (error) {
    await lock.release();
    throw error;
  }
}

async function seedSequences(
  layout: PersistenceLayout,
  coordinator: SessionWriteCoordinator,
  committed: ReadonlySet<string>,
): Promise<void> {
  const registry = await readJsonlFile(
    layout.workspaceRegistryFile,
    parseWorkspaceRecord,
  );
  let maxWorkspace = 0;
  for (const record of registry.records) {
    if (committed.has(record.transactionId) && record.sequence > maxWorkspace) {
      maxWorkspace = record.sequence;
    }
  }
  coordinator.seedWorkspaceSequence(maxWorkspace);

  let sessions: string[];
  try {
    const { readdir } = await import('node:fs/promises');
    sessions = await readdir(layout.sessionsDir);
  } catch {
    return;
  }
  for (const sessionId of sessions) {
    const { records } = await readJsonlFile(
      sessionEventsPath(layout, sessionId),
      parseSessionEvent,
    );
    let max = 0;
    for (const event of records) {
      if (committed.has(event.transactionId) && event.sequence > max) {
        max = event.sequence;
      }
    }
    coordinator.seedSessionSequence(sessionId, max);
  }
}
