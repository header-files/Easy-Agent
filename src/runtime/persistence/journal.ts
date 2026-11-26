import { randomUUID } from 'node:crypto';
import { PersistenceError } from './errors.ts';
import {
  appendJsonlRecord,
  readJsonlFile,
  type JsonlReadResult,
} from './jsonl-store.ts';
import type { DurableFsHooks } from './durable-fs.ts';
import type { PersistenceLayout } from './paths.ts';
import {
  PERSISTENCE_SCHEMA_VERSION,
  type CommittedMarker,
  type JournalRecord,
  type PersistOperation,
  type PreparedTransaction,
} from './types.ts';

export class TransactionJournal {
  private readonly filePath: string;
  private serial: Promise<void> = Promise.resolve();

  constructor(layout: PersistenceLayout) {
    this.filePath = layout.journalFile;
  }

  async readAll(): Promise<JsonlReadResult<JournalRecord>> {
    return readJsonlFile(this.filePath, parseJournalRecord);
  }

  /** Serialize all journal appends globally. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.serial.then(work, work);
    this.serial = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async appendPrepared(
    operations: readonly PersistOperation[],
    hooks?: DurableFsHooks,
  ): Promise<PreparedTransaction> {
    if (operations.length === 0) {
      throw new PersistenceError('invalid_request');
    }
    const transactionId = randomUUID();
    const prepared: PreparedTransaction = {
      transactionId,
      state: 'PREPARED',
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      operations: operations.map((op) => {
        const clone = structuredClone(op);
        const record = clone.record as { transactionId?: string };
        record.transactionId = transactionId;
        return clone;
      }),
      createdAt: new Date().toISOString(),
    };
    Object.freeze(prepared);
    Object.freeze(prepared.operations);
    await this.enqueue(() => appendJsonlRecord(this.filePath, prepared, hooks));
    return prepared;
  }

  async appendPreparedFixed(
    prepared: PreparedTransaction,
    hooks?: DurableFsHooks,
  ): Promise<void> {
    if (prepared.state !== 'PREPARED') {
      throw new PersistenceError('invalid_request');
    }
    await this.enqueue(() => appendJsonlRecord(this.filePath, prepared, hooks));
  }

  async appendCommitted(
    transactionId: string,
    hooks?: DurableFsHooks,
  ): Promise<CommittedMarker> {
    if (typeof transactionId !== 'string' || transactionId.length === 0) {
      throw new PersistenceError('invalid_request');
    }
    const marker: CommittedMarker = {
      transactionId,
      state: 'COMMITTED',
      schemaVersion: PERSISTENCE_SCHEMA_VERSION,
      committedAt: new Date().toISOString(),
    };
    await this.enqueue(() => appendJsonlRecord(this.filePath, marker, hooks));
    return marker;
  }
}

function parseJournalRecord(value: unknown): JournalRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PersistenceError('invalid_record');
  }
  const record = value as Record<string, unknown>;
  if (record.state === 'PREPARED') {
    if (
      typeof record.transactionId !== 'string' ||
      record.schemaVersion !== PERSISTENCE_SCHEMA_VERSION ||
      typeof record.createdAt !== 'string' ||
      !Array.isArray(record.operations) ||
      record.operations.length === 0
    ) {
      throw new PersistenceError('invalid_record');
    }
    return value as PreparedTransaction;
  }
  if (record.state === 'COMMITTED') {
    if (
      typeof record.transactionId !== 'string' ||
      record.schemaVersion !== PERSISTENCE_SCHEMA_VERSION ||
      typeof record.committedAt !== 'string'
    ) {
      throw new PersistenceError('invalid_record');
    }
    return value as CommittedMarker;
  }
  throw new PersistenceError('invalid_record');
}

export function indexJournal(records: readonly JournalRecord[]): {
  prepared: Map<string, PreparedTransaction>;
  committed: Set<string>;
} {
  const prepared = new Map<string, PreparedTransaction>();
  const committed = new Map<string, CommittedMarker>();
  for (const record of records) {
    if (record.state === 'PREPARED') {
      const existing = prepared.get(record.transactionId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(record)) {
        throw new PersistenceError(
          'conflict',
          `Conflicting PREPARED for ${record.transactionId}.`,
        );
      }
      prepared.set(record.transactionId, record);
    } else {
      // COMMITTED must follow a PREPARED for the same transaction in stream order.
      if (!prepared.has(record.transactionId)) {
        throw new PersistenceError(
          'corrupt_store',
          `COMMITTED ${record.transactionId} appears before its PREPARED record.`,
        );
      }
      const existing = committed.get(record.transactionId);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(record)) {
          throw new PersistenceError(
            'conflict',
            `Conflicting COMMITTED markers for ${record.transactionId}.`,
          );
        }
        // Identical duplicate COMMITTED is treated as anomalous journal content.
        throw new PersistenceError(
          'corrupt_store',
          `Duplicate COMMITTED marker for ${record.transactionId}.`,
        );
      }
      committed.set(record.transactionId, record);
    }
  }
  return { prepared, committed: new Set(committed.keys()) };
}
