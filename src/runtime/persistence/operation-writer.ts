import { PersistenceError } from './errors.ts';
import { appendJsonlRecord, findById, readJsonlFile } from './jsonl-store.ts';
import { stableStringify, type DurableFsHooks } from './durable-fs.ts';
import { sessionEventsPath, type PersistenceLayout } from './paths.ts';
import {
  PERSISTENCE_SCHEMA_VERSION,
  type PersistOperation,
  type SessionEventEnvelope,
  type WorkspaceRegistryRecord,
} from './types.ts';

/** Idempotently write one prepared operation to its target store. */
export async function writeOperation(
  layout: PersistenceLayout,
  operation: PersistOperation,
  hooks?: DurableFsHooks,
): Promise<'written' | 'skipped'> {
  if (operation.target === 'session_events') {
    if (
      typeof operation.sessionId !== 'string' ||
      operation.sessionId.length === 0
    ) {
      throw new PersistenceError('invalid_request');
    }
    const record = operation.record as SessionEventEnvelope;
    assertSessionEvent(record);
    const filePath = sessionEventsPath(layout, operation.sessionId);
    const { records } = await readJsonlFile(filePath, parseSessionEvent);
    const existing = findById(records, record.id, record);
    if (existing) return 'skipped';
    // Sequence uniqueness within session.
    if (records.some((item) => item.sequence === record.sequence)) {
      throw new PersistenceError(
        'conflict',
        `Sequence ${record.sequence} already used in session ${operation.sessionId}.`,
      );
    }
    await appendJsonlRecord(filePath, record, hooks);
    return 'written';
  }

  if (operation.target === 'workspace_registry') {
    const record = operation.record as WorkspaceRegistryRecord;
    assertWorkspaceRecord(record);
    const { records } = await readJsonlFile(
      layout.workspaceRegistryFile,
      parseWorkspaceRecord,
    );
    const existing = findById(records, record.id, record);
    if (existing) return 'skipped';
    if (records.some((item) => item.sequence === record.sequence)) {
      throw new PersistenceError(
        'conflict',
        `Workspace registry sequence ${record.sequence} already used.`,
      );
    }
    await appendJsonlRecord(layout.workspaceRegistryFile, record, hooks);
    return 'written';
  }

  throw new PersistenceError('invalid_request');
}

export async function writeAllOperations(
  layout: PersistenceLayout,
  operations: readonly PersistOperation[],
  hooks?: DurableFsHooks,
): Promise<void> {
  for (const operation of operations) {
    await writeOperation(layout, operation, hooks);
  }
}

/**
 * Fail closed when a COMMITTED transaction's Operations are missing or differ
 * from the frozen PREPARED content.
 */
export async function verifyCommittedOperations(
  layout: PersistenceLayout,
  operations: readonly PersistOperation[],
): Promise<void> {
  for (const operation of operations) {
    if (operation.target === 'session_events') {
      if (
        typeof operation.sessionId !== 'string' ||
        operation.sessionId.length === 0
      ) {
        throw new PersistenceError('corrupt_store');
      }
      const record = operation.record as SessionEventEnvelope;
      const { records } = await readJsonlFile(
        sessionEventsPath(layout, operation.sessionId),
        parseSessionEvent,
      );
      const found = findById(records, record.id, record);
      if (!found) {
        throw new PersistenceError(
          'corrupt_store',
          `Committed session operation ${record.id} is missing from Event Log.`,
        );
      }
      continue;
    }
    if (operation.target === 'workspace_registry') {
      const record = operation.record as WorkspaceRegistryRecord;
      const { records } = await readJsonlFile(
        layout.workspaceRegistryFile,
        parseWorkspaceRecord,
      );
      const found = findById(records, record.id, record);
      if (!found) {
        throw new PersistenceError(
          'corrupt_store',
          `Committed workspace operation ${record.id} is missing from Registry.`,
        );
      }
      continue;
    }
    throw new PersistenceError('corrupt_store');
  }
}

function assertSessionEvent(record: SessionEventEnvelope): void {
  if (
    typeof record.id !== 'string' ||
    typeof record.sessionId !== 'string' ||
    typeof record.sequence !== 'number' ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence < 1 ||
    typeof record.transactionId !== 'string' ||
    typeof record.type !== 'string' ||
    typeof record.timestamp !== 'string' ||
    record.schemaVersion !== PERSISTENCE_SCHEMA_VERSION
  ) {
    throw new PersistenceError('invalid_record');
  }
}

function assertWorkspaceRecord(record: WorkspaceRegistryRecord): void {
  if (
    typeof record.id !== 'string' ||
    typeof record.sequence !== 'number' ||
    !Number.isSafeInteger(record.sequence) ||
    record.sequence < 1 ||
    typeof record.transactionId !== 'string' ||
    typeof record.type !== 'string' ||
    typeof record.timestamp !== 'string' ||
    record.schemaVersion !== PERSISTENCE_SCHEMA_VERSION
  ) {
    throw new PersistenceError('invalid_record');
  }
}

export function parseSessionEvent(value: unknown): SessionEventEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PersistenceError('invalid_record');
  }
  const record = value as SessionEventEnvelope;
  assertSessionEvent(record);
  return record;
}

export function parseWorkspaceRecord(value: unknown): WorkspaceRegistryRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PersistenceError('invalid_record');
  }
  const record = value as WorkspaceRegistryRecord;
  assertWorkspaceRecord(record);
  return record;
}

export function sameRecord(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}
