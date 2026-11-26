import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PersistenceError } from './errors.ts';
import type { DurableFsHooks } from './durable-fs.ts';
import { ensureDir } from './durable-fs.ts';
import type { TransactionJournal } from './journal.ts';
import { writeAllOperations } from './operation-writer.ts';
import { sessionEventsPath, type PersistenceLayout } from './paths.ts';
import {
  PERSISTENCE_SCHEMA_VERSION,
  type PersistOperation,
  type PreparedTransaction,
  type SessionEventEnvelope,
  type WorkspaceRegistryRecord,
} from './types.ts';

const WORKSPACE_SCOPE = '__workspace_registry__';

export type CommitOutcome =
  | { status: 'committed'; transactionId: string }
  | { status: 'not_prepared'; error: PersistenceError }
  | { status: 'commit_uncertain'; error: PersistenceError };

export interface SessionEventDraft {
  type: string;
  payload: unknown;
  executionId?: string;
}

export interface WorkspaceRecordDraft {
  type: string;
  payload: unknown;
}

/**
 * Runtime-level manager: global journal serialization + per-session FIFO queues
 * and sequence allocation. Workspace registry sequences are allocated separately.
 */
export class SessionWriteCoordinator {
  private readonly layout: PersistenceLayout;
  private readonly journal: TransactionJournal;
  private readonly sessionQueues = new Map<string, Promise<unknown>>();
  private readonly sessionSequences = new Map<string, number>();
  private workspaceSequence = 0;
  private readonly committedIds = new Set<string>();
  /** Scopes frozen after COMMIT_UNCERTAIN until process restart / recovery. */
  private readonly frozenScopes = new Set<string>();
  /** Journal append failures freeze all new durable transactions. */
  private journalFrozen = false;

  constructor(layout: PersistenceLayout, journal: TransactionJournal) {
    this.layout = layout;
    this.journal = journal;
  }

  isScopeFrozen(scope: string): boolean {
    return this.journalFrozen || this.frozenScopes.has(scope);
  }

  isJournalFrozen(): boolean {
    return this.journalFrozen;
  }

  markCommitted(transactionId: string): void {
    this.committedIds.add(transactionId);
  }

  isCommitted(transactionId: string): boolean {
    return this.committedIds.has(transactionId);
  }

  seedSessionSequence(sessionId: string, lastSequence: number): void {
    const current = this.sessionSequences.get(sessionId) ?? 0;
    if (lastSequence > current)
      this.sessionSequences.set(sessionId, lastSequence);
  }

  seedWorkspaceSequence(lastSequence: number): void {
    if (lastSequence > this.workspaceSequence) {
      this.workspaceSequence = lastSequence;
    }
  }

  async commitSessionEvents(
    sessionId: string,
    drafts: readonly SessionEventDraft[],
    hooks?: DurableFsHooks,
  ): Promise<CommitOutcome> {
    if (drafts.length === 0) {
      return {
        status: 'not_prepared',
        error: new PersistenceError('invalid_request'),
      };
    }
    return this.enqueueSession(sessionId, async () => {
      const frozen = this.rejectIfFrozen(sessionId);
      if (frozen) return frozen;
      await ensureDir(path.dirname(sessionEventsPath(this.layout, sessionId)));
      const transactionId = randomUUID();
      const timestamp = new Date().toISOString();
      const operations: PersistOperation[] = drafts.map((draft) => {
        const sequence = (this.sessionSequences.get(sessionId) ?? 0) + 1;
        this.sessionSequences.set(sessionId, sequence);
        const record: SessionEventEnvelope = {
          id: randomUUID(),
          sessionId,
          sequence,
          transactionId,
          type: draft.type,
          payload: structuredClone(draft.payload),
          timestamp,
          schemaVersion: PERSISTENCE_SCHEMA_VERSION,
          ...(draft.executionId === undefined
            ? {}
            : { executionId: draft.executionId }),
        };
        return {
          operationId: randomUUID(),
          target: 'session_events',
          sessionId,
          record,
        };
      });
      return this.commitPreparedFixed(
        sessionId,
        {
          transactionId,
          state: 'PREPARED',
          schemaVersion: PERSISTENCE_SCHEMA_VERSION,
          operations,
          createdAt: timestamp,
        },
        hooks,
      );
    });
  }

  async commitWorkspaceRecords(
    drafts: readonly WorkspaceRecordDraft[],
    hooks?: DurableFsHooks,
  ): Promise<CommitOutcome> {
    if (drafts.length === 0) {
      return {
        status: 'not_prepared',
        error: new PersistenceError('invalid_request'),
      };
    }
    // Workspace registry writes serialize through the journal queue via enqueue on a sentinel.
    return this.enqueueSession(WORKSPACE_SCOPE, async () => {
      const frozen = this.rejectIfFrozen(WORKSPACE_SCOPE);
      if (frozen) return frozen;
      const transactionId = randomUUID();
      const timestamp = new Date().toISOString();
      const operations: PersistOperation[] = drafts.map((draft) => {
        const sequence = ++this.workspaceSequence;
        const record: WorkspaceRegistryRecord = {
          id: randomUUID(),
          sequence,
          transactionId,
          type: draft.type,
          payload: structuredClone(draft.payload),
          timestamp,
          schemaVersion: PERSISTENCE_SCHEMA_VERSION,
        };
        return {
          operationId: randomUUID(),
          target: 'workspace_registry',
          record,
        };
      });
      return this.commitPreparedFixed(
        WORKSPACE_SCOPE,
        {
          transactionId,
          state: 'PREPARED',
          schemaVersion: PERSISTENCE_SCHEMA_VERSION,
          operations,
          createdAt: timestamp,
        },
        hooks,
      );
    });
  }

  private rejectIfFrozen(scope: string): CommitOutcome | undefined {
    if (!this.journalFrozen && !this.frozenScopes.has(scope)) return undefined;
    return {
      status: 'commit_uncertain',
      error: new PersistenceError(
        'unavailable',
        this.journalFrozen
          ? 'Global journal is frozen after an uncertain commit.'
          : `Persistence scope ${scope} is frozen after an uncertain commit.`,
      ),
    };
  }

  private freezeScope(scope: string): void {
    this.frozenScopes.add(scope);
  }

  private freezeJournal(): void {
    this.journalFrozen = true;
  }

  private async commitPreparedFixed(
    scope: string,
    prepared: PreparedTransaction,
    hooks?: DurableFsHooks,
  ): Promise<CommitOutcome> {
    try {
      await this.journal.appendPreparedFixed(prepared, hooks);
    } catch (error) {
      const pe =
        error instanceof PersistenceError
          ? error
          : new PersistenceError('commit_uncertain');
      if (pe.code === 'commit_uncertain' || pe.code === 'io_failed') {
        // Journal itself failed — stop all new durable transactions.
        this.freezeJournal();
        this.freezeScope(scope);
        return { status: 'commit_uncertain', error: pe };
      }
      return { status: 'not_prepared', error: pe };
    }

    try {
      await writeAllOperations(this.layout, prepared.operations, hooks);
    } catch (error) {
      // Target store failure freezes the affected scope only.
      this.freezeScope(scope);
      return {
        status: 'commit_uncertain',
        error:
          error instanceof PersistenceError
            ? error
            : new PersistenceError('commit_uncertain'),
      };
    }

    try {
      await this.journal.appendCommitted(prepared.transactionId, hooks);
    } catch (error) {
      this.freezeJournal();
      this.freezeScope(scope);
      return {
        status: 'commit_uncertain',
        error:
          error instanceof PersistenceError
            ? error
            : new PersistenceError('commit_uncertain'),
      };
    }

    this.committedIds.add(prepared.transactionId);
    return { status: 'committed', transactionId: prepared.transactionId };
  }

  private enqueueSession<T>(
    sessionId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.sessionQueues.set(
      sessionId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }
}
