/** Schema version for journal / event / registry records. */
export const PERSISTENCE_SCHEMA_VERSION = 1;

export type TransactionState = 'PREPARED' | 'COMMITTED';

export type PersistTargetKind = 'session_events' | 'workspace_registry';

export interface SessionEventEnvelope {
  id: string;
  sessionId: string;
  executionId?: string;
  sequence: number;
  transactionId: string;
  type: string;
  payload: unknown;
  timestamp: string;
  schemaVersion: number;
}

export interface WorkspaceRegistryRecord {
  id: string;
  sequence: number;
  transactionId: string;
  type: string;
  payload: unknown;
  timestamp: string;
  schemaVersion: number;
}

export interface PersistOperation {
  operationId: string;
  target: PersistTargetKind;
  /** Session id when target is session_events. */
  sessionId?: string;
  /** Frozen record content; must be fully recoverable without process memory. */
  record: SessionEventEnvelope | WorkspaceRegistryRecord;
}

export interface PreparedTransaction {
  transactionId: string;
  state: 'PREPARED';
  schemaVersion: number;
  operations: readonly PersistOperation[];
  createdAt: string;
}

export interface CommittedMarker {
  transactionId: string;
  state: 'COMMITTED';
  schemaVersion: number;
  committedAt: string;
}

export type JournalRecord = PreparedTransaction | CommittedMarker;

export type SessionEventType =
  | 'session/created'
  | 'session/model_changed'
  | 'session/deleted'
  | 'execution/created'
  | 'execution/started'
  | 'execution/completed'
  | 'execution/failed'
  | 'execution/cancelled'
  | 'execution/interrupted_detected'
  | 'user/message'
  | 'llm/request'
  | 'llm/response'
  | 'tool/call'
  | 'tool/result'
  | 'approval/requested'
  | 'approval/resolved'
  | 'context/summary_committed';

export type WorkspaceRegistryEventType =
  | 'workspace/registered'
  | 'workspace/removed'
  | 'workspace/terminal_intent'
  | 'workspace/terminal_settled'
  | 'workspace/unsafe'
  | 'workspace/recovered';
