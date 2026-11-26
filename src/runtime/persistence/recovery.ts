import { PersistenceError } from './errors.ts';
import { indexJournal, type TransactionJournal } from './journal.ts';
import {
  verifyCommittedOperations,
  writeAllOperations,
} from './operation-writer.ts';
import type { PersistenceLayout } from './paths.ts';
import type { PreparedTransaction } from './types.ts';

export interface RecoveryResult {
  committedTransactionIds: ReadonlySet<string>;
  rolledForward: readonly string[];
  truncatedJournalTail: boolean;
}

/**
 * Roll Forward: for each durable PREPARED without COMMITTED, rewrite the same
 * operations idempotently and append COMMITTED. Never re-executes LLM/Tool.
 * For already-COMMITTED transactions, verify target Operations still match.
 */
export async function rollForward(
  layout: PersistenceLayout,
  journal: TransactionJournal,
): Promise<RecoveryResult> {
  const { records, truncatedTail } = await journal.readAll();
  const { prepared, committed } = indexJournal(records);
  const rolledForward: string[] = [];

  // COMMITTED without a matching PREPARED cannot be verified → fail closed.
  for (const transactionId of committed) {
    if (!prepared.has(transactionId)) {
      throw new PersistenceError(
        'corrupt_store',
        `COMMITTED transaction ${transactionId} has no PREPARED record.`,
      );
    }
  }

  for (const [transactionId, preparedTx] of prepared) {
    validatePrepared(preparedTx);
    if (committed.has(transactionId)) {
      await verifyCommittedOperations(layout, preparedTx.operations);
      continue;
    }
    try {
      await writeAllOperations(layout, preparedTx.operations);
      await journal.appendCommitted(transactionId);
      committed.add(transactionId);
      rolledForward.push(transactionId);
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError('commit_uncertain');
    }
  }

  return {
    committedTransactionIds: committed,
    rolledForward,
    truncatedJournalTail: truncatedTail,
  };
}

function validatePrepared(prepared: PreparedTransaction): void {
  if (prepared.state !== 'PREPARED' || prepared.operations.length === 0) {
    throw new PersistenceError(
      'corrupt_store',
      `PREPARED transaction ${prepared.transactionId} is incomplete.`,
    );
  }
  for (const operation of prepared.operations) {
    if (
      typeof operation.operationId !== 'string' ||
      (operation.target !== 'session_events' &&
        operation.target !== 'workspace_registry')
    ) {
      throw new PersistenceError(
        'corrupt_store',
        `PREPARED transaction ${prepared.transactionId} has an invalid operation.`,
      );
    }
    if (
      operation.target === 'session_events' &&
      typeof operation.sessionId !== 'string'
    ) {
      throw new PersistenceError(
        'corrupt_store',
        `PREPARED transaction ${prepared.transactionId} is missing sessionId on an Event Log operation.`,
      );
    }
    const record = operation.record;
    if (
      typeof record !== 'object' ||
      record === null ||
      typeof record.transactionId !== 'string'
    ) {
      throw new PersistenceError(
        'corrupt_store',
        `PREPARED transaction ${prepared.transactionId} has an operation without a record transactionId.`,
      );
    }
    if (record.transactionId !== prepared.transactionId) {
      throw new PersistenceError(
        'corrupt_store',
        `Operation record transactionId ${record.transactionId} does not match PREPARED ${prepared.transactionId}.`,
      );
    }
    if (
      operation.target === 'session_events' &&
      'sessionId' in record &&
      record.sessionId !== operation.sessionId
    ) {
      throw new PersistenceError(
        'corrupt_store',
        `Operation sessionId ${String(operation.sessionId)} does not match record sessionId ${String(record.sessionId)}.`,
      );
    }
  }
}
