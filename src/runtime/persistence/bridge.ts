import { isDurableCommittedFailure, PersistenceError } from './errors.ts';
import type { DurableFsHooks } from './durable-fs.ts';
import type { PersistenceRuntime } from './persistence-runtime.ts';
import type {
  SessionEventDraft,
  WorkspaceRecordDraft,
} from './session-write-coordinator.ts';

/**
 * Fail-closed helper used by Agent / Tool / Workspace call sites.
 * Throws PersistenceError when a required commit does not succeed.
 * When Journal COMMITTED but projection refresh fails, throws with
 * `durableCommitted: true` so callers do not roll back durable truth.
 */
export class PersistenceBridge {
  private readonly runtime: PersistenceRuntime;
  /** Test injection: fail the next N projection refreshes after a successful commit. */
  private refreshFailuresRemaining = 0;
  /** Test injection: fail Journal COMMITTED sync on the next N commits. */
  private committedSyncFailuresRemaining = 0;

  constructor(runtime: PersistenceRuntime) {
    this.runtime = runtime;
  }

  get projections() {
    return this.runtime.projections;
  }

  get lifecycle() {
    return this.runtime.lifecycle;
  }

  /** @internal Test-only: next `count` refreshes after commit throw. */
  failNextProjectionRefresh(count = 1): void {
    this.refreshFailuresRemaining = Math.max(0, count);
  }

  /**
   * @internal Test-only: next `count` commits fail while syncing COMMITTED
   * (PREPARED + Operations may already be durable → commit_uncertain).
   */
  failNextCommittedSync(count = 1): void {
    this.committedSyncFailuresRemaining = Math.max(0, count);
  }

  async requireSessionEvents(
    sessionId: string,
    drafts: readonly SessionEventDraft[],
  ): Promise<string> {
    const outcome = await this.runtime.commitSessionEvents(
      sessionId,
      drafts,
      this.takeCommitHooks(),
    );
    if (outcome.status !== 'committed') {
      throw outcome.error;
    }
    await this.refreshAfterCommit(outcome.transactionId);
    return outcome.transactionId;
  }

  async requireWorkspaceRecords(
    drafts: readonly WorkspaceRecordDraft[],
  ): Promise<string> {
    const outcome = await this.runtime.commitWorkspaceRecords(
      drafts,
      this.takeCommitHooks(),
    );
    if (outcome.status !== 'committed') {
      throw outcome.error;
    }
    await this.refreshAfterCommit(outcome.transactionId);
    return outcome.transactionId;
  }

  private takeCommitHooks(): DurableFsHooks | undefined {
    if (this.committedSyncFailuresRemaining <= 0) return undefined;
    this.committedSyncFailuresRemaining -= 1;
    return { failBeforeSyncIfLineIncludes: '"state":"COMMITTED"' };
  }

  private async refreshAfterCommit(transactionId: string): Promise<void> {
    try {
      if (this.refreshFailuresRemaining > 0) {
        this.refreshFailuresRemaining -= 1;
        throw new PersistenceError(
          'projection_refresh_failed',
          'Injected projection refresh failure.',
        );
      }
      await this.runtime.refreshProjections();
    } catch (error) {
      if (isDurableCommittedFailure(error)) throw error;
      throw new PersistenceError(
        'projection_refresh_failed',
        error instanceof Error
          ? error.message
          : 'Projection refresh failed after durable commit.',
        { durableCommitted: true, transactionId },
      );
    }
  }

  async dispose(): Promise<void> {
    await this.runtime.dispose();
  }
}

export function isPersistenceFailure(error: unknown): boolean {
  return error instanceof PersistenceError;
}
