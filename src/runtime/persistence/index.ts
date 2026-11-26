export {
  PersistenceError,
  isDurableCommittedFailure,
  isCommitUncertain,
  type PersistenceErrorCode,
  type PersistenceErrorOptions,
} from './errors.ts';
export {
  PERSISTENCE_SCHEMA_VERSION,
  type CommittedMarker,
  type JournalRecord,
  type PersistOperation,
  type PersistTargetKind,
  type PreparedTransaction,
  type SessionEventEnvelope,
  type SessionEventType,
  type TransactionState,
  type WorkspaceRegistryEventType,
  type WorkspaceRegistryRecord,
} from './types.ts';
export {
  resolveLayout,
  sessionEventsPath,
  assertSafeSessionStorageId,
  type PersistenceLayout,
} from './paths.ts';
export {
  stableStringify,
  assertDurableJsonValue,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  type DurableFsHooks,
} from './durable-fs.ts';
export { readJsonlFile, appendJsonlRecord } from './jsonl-store.ts';
export { acquireWriteLock, type WriteLock } from './write-lock.ts';
export { TransactionJournal, indexJournal } from './journal.ts';
export {
  writeOperation,
  writeAllOperations,
  verifyCommittedOperations,
  parseSessionEvent,
  parseWorkspaceRecord,
} from './operation-writer.ts';
export {
  SessionWriteCoordinator,
  type CommitOutcome,
  type SessionEventDraft,
  type WorkspaceRecordDraft,
} from './session-write-coordinator.ts';
export { rollForward, type RecoveryResult } from './recovery.ts';
export {
  replayProjections,
  assertProjectionReferences,
  type ReplayProjectionsOptions,
  type ProjectionState,
  type SessionProjection,
  type ExecutionProjection,
  type MessageProjectionItem,
  type WorkspaceProjection,
  type ExecutionTerminalStatus,
} from './projections.ts';
export { WorkspaceLifecycleCoordinator } from './lifecycle-coordinator.ts';
export {
  openPersistenceRuntime,
  type PersistenceRuntime,
} from './persistence-runtime.ts';
export { PersistenceBridge, isPersistenceFailure } from './bridge.ts';
