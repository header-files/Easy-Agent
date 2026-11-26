import fs from 'node:fs/promises';
import path from 'node:path';
import { PersistenceError } from './errors.ts';
import { readJsonlFile } from './jsonl-store.ts';
import { parseSessionEvent, parseWorkspaceRecord } from './operation-writer.ts';
import type { PersistenceLayout } from './paths.ts';
import type { SessionEventEnvelope, WorkspaceRegistryRecord } from './types.ts';

export type ExecutionTerminalStatus =
  'COMPLETED' | 'FAILED' | 'CANCELLED' | 'INTERRUPTED';

export interface SessionProjection {
  sessionId: string;
  model?: string;
  modelParameters?: Record<string, unknown>;
  allowedNames?: string[];
  extensions?: Record<string, unknown>;
  /** Initial committed context from session/created (before Execution history). */
  initialContext?: {
    messages: unknown[];
    data?: Record<string, unknown>;
  };
  workspaceId?: string;
  createdAt?: string;
  /** True after committed session/deleted; skipped on cold-start restore. */
  removed?: boolean;
  /**
   * True when Message Projection was replaced by an authoritative
   * execution/completed `context` snapshot (Phase 1 updatedContext semantics).
   */
  messagesAuthoritative?: boolean;
  /**
   * Context.data from the last authoritative execution/completed snapshot.
   * Absent when that snapshot omitted data (full-replace semantics).
   */
  committedContextData?: Record<string, unknown>;
}

export interface ExecutionProjection {
  executionId: string;
  sessionId: string;
  input?: string;
  model?: string;
  allowedNames?: string[];
  status: ExecutionTerminalStatus | 'CREATED' | 'STARTED';
  result?: unknown;
  error?: unknown;
  interrupted?: boolean;
  /** Set when cold-start upgraded CREATED/STARTED → INTERRUPTED (needs durable fact). */
  needsInterruptPersist?: boolean;
}

export interface MessageProjectionItem {
  role: 'user' | 'assistant' | 'tool';
  content?: string;
  toolCallId?: string;
  toolCalls?: unknown;
  isError?: boolean;
  executionId: string;
}

export interface WorkspaceProjection {
  workspaceId: string;
  name?: string;
  rootPath?: string;
  removed: boolean;
  safety: 'NORMAL' | 'UNSAFE';
  openIntents: Set<string>;
  recoveredThrough?: string[];
}

export interface ProjectionState {
  sessions: Map<string, SessionProjection>;
  executions: Map<string, ExecutionProjection>;
  /** Messages eligible for model context: only COMPLETED executions. */
  messagesBySession: Map<string, MessageProjectionItem[]>;
  workspaces: Map<string, WorkspaceProjection>;
  /** Derived from committed session facts. */
  workspaceSessionRefs: Map<string, Set<string>>;
}

export interface ReplayProjectionsOptions {
  /**
   * Cold-start recovery only: upgrade unfinished CREATED/STARTED → INTERRUPTED.
   * Must stay false for in-process refreshProjections so live executions remain accurate.
   */
  interruptUnfinished?: boolean;
}

/** Replay only events whose transactionId is in the committed set. */
export async function replayProjections(
  layout: PersistenceLayout,
  committedTransactionIds: ReadonlySet<string>,
  options: ReplayProjectionsOptions = {},
): Promise<ProjectionState> {
  const state: ProjectionState = {
    sessions: new Map(),
    executions: new Map(),
    messagesBySession: new Map(),
    workspaces: new Map(),
    workspaceSessionRefs: new Map(),
  };

  await replayWorkspaceRegistry(layout, committedTransactionIds, state);
  await replayAllSessions(layout, committedTransactionIds, state);
  deriveWorkspaceRefs(state);
  if (options.interruptUnfinished === true) {
    markInterruptedExecutions(state);
  }
  applyWorkspaceSafety(state);
  assertProjectionReferences(state);
  return state;
}

/**
 * Fail closed when a live Session references a missing/removed Workspace
 * (or one without a recoverable root path). Must not open writable mode.
 */
export function assertProjectionReferences(state: ProjectionState): void {
  for (const session of state.sessions.values()) {
    if (session.removed || session.workspaceId === undefined) continue;
    const workspace = state.workspaces.get(session.workspaceId);
    if (!workspace || workspace.removed) {
      throw new PersistenceError(
        'corrupt_store',
        `Session ${session.sessionId} references missing workspace ${session.workspaceId}.`,
      );
    }
    if (
      typeof workspace.rootPath !== 'string' ||
      workspace.rootPath.length === 0
    ) {
      throw new PersistenceError(
        'corrupt_store',
        `Session ${session.sessionId} references workspace ${session.workspaceId} without a recoverable root path.`,
      );
    }
  }
}

async function replayWorkspaceRegistry(
  layout: PersistenceLayout,
  committed: ReadonlySet<string>,
  state: ProjectionState,
): Promise<void> {
  const { records } = await readJsonlFile(
    layout.workspaceRegistryFile,
    parseWorkspaceRecord,
  );
  const ordered = records
    .filter((item) => committed.has(item.transactionId))
    .sort((a, b) => a.sequence - b.sequence);
  for (const record of ordered) {
    applyWorkspaceRecord(state, record);
  }
}

async function replayAllSessions(
  layout: PersistenceLayout,
  committed: ReadonlySet<string>,
  state: ProjectionState,
): Promise<void> {
  let sessionDirs: string[];
  try {
    sessionDirs = await fs.readdir(layout.sessionsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new PersistenceError('io_failed');
  }
  for (const sessionId of sessionDirs) {
    const eventsPath = path.join(layout.sessionsDir, sessionId, 'events.jsonl');
    const { records } = await readJsonlFile(eventsPath, parseSessionEvent);
    const ordered = records
      .filter((item) => committed.has(item.transactionId))
      .sort((a, b) => a.sequence - b.sequence);
    // Detect sequence gaps / conflicts.
    let expected = 1;
    for (const event of ordered) {
      if (event.sequence < expected) {
        throw new PersistenceError(
          'conflict',
          `Session ${sessionId} sequence regression at ${event.sequence}.`,
        );
      }
      // Gaps are allowed only if uncommitted events were filtered; sequences
      // among committed events must be strictly increasing without reuse.
      if (event.sequence === expected - 1) {
        throw new PersistenceError('conflict');
      }
      applySessionEvent(state, event);
      expected = event.sequence + 1;
    }
  }
}

function applyWorkspaceRecord(
  state: ProjectionState,
  record: WorkspaceRegistryRecord,
): void {
  const payload = asRecord(record.payload);
  if (record.type === 'workspace/registered') {
    const workspaceId = String(payload.workspaceId ?? '');
    if (!workspaceId) throw new PersistenceError('invalid_record');
    const name = optionalString(payload.name);
    const rootPath = optionalString(payload.rootPath);
    state.workspaces.set(workspaceId, {
      workspaceId,
      removed: false,
      safety: 'NORMAL',
      openIntents: new Set(),
      ...(name === undefined ? {} : { name }),
      ...(rootPath === undefined ? {} : { rootPath }),
    });
    return;
  }
  const workspaceId = String(payload.workspaceId ?? '');
  const current = state.workspaces.get(workspaceId);
  if (!current && record.type !== 'workspace/registered') return;
  if (!current) return;
  if (record.type === 'workspace/removed') {
    current.removed = true;
    return;
  }
  if (record.type === 'workspace/terminal_intent') {
    const activityId = String(payload.activityId ?? '');
    if (activityId) current.openIntents.add(activityId);
    return;
  }
  if (record.type === 'workspace/terminal_settled') {
    const activityId = String(payload.activityId ?? '');
    if (activityId) current.openIntents.delete(activityId);
    return;
  }
  if (record.type === 'workspace/unsafe') {
    current.safety = 'UNSAFE';
    return;
  }
  if (record.type === 'workspace/recovered') {
    const covered = Array.isArray(payload.coveredActivityIds)
      ? payload.coveredActivityIds.map(String)
      : [];
    for (const id of covered) current.openIntents.delete(id);
    current.recoveredThrough = covered;
    if (current.openIntents.size === 0) current.safety = 'NORMAL';
    else current.safety = 'UNSAFE';
  }
}

function applySessionEvent(
  state: ProjectionState,
  event: SessionEventEnvelope,
): void {
  const payload = asRecord(event.payload);
  if (event.type === 'session/created') {
    const model = optionalString(payload.model);
    const allowedNames = optionalStringArray(payload.allowedNames);
    const workspaceId = optionalString(payload.workspaceId);
    const modelParameters = asOptionalRecord(payload.modelParameters);
    const extensions = asOptionalRecord(payload.extensions);
    const initialContext = asInitialContext(payload.context);
    state.sessions.set(event.sessionId, {
      sessionId: event.sessionId,
      createdAt: event.timestamp,
      removed: false,
      ...(model === undefined ? {} : { model }),
      ...(modelParameters === undefined ? {} : { modelParameters }),
      ...(allowedNames === undefined ? {} : { allowedNames }),
      ...(extensions === undefined ? {} : { extensions }),
      ...(initialContext === undefined ? {} : { initialContext }),
      ...(workspaceId === undefined ? {} : { workspaceId }),
    });
    return;
  }
  const session = state.sessions.get(event.sessionId);
  if (event.type === 'session/deleted' && session) {
    session.removed = true;
    return;
  }
  if (event.type === 'session/model_changed' && session) {
    const model = optionalString(payload.model);
    if (model !== undefined) session.model = model;
    return;
  }
  if (event.type === 'execution/created') {
    const executionId = event.executionId ?? String(payload.executionId ?? '');
    if (!executionId) throw new PersistenceError('invalid_record');
    const input = optionalString(payload.input);
    const model = optionalString(payload.model);
    const allowedNames = optionalStringArray(payload.allowedNames);
    state.executions.set(executionId, {
      executionId,
      sessionId: event.sessionId,
      status: 'CREATED',
      ...(input === undefined ? {} : { input }),
      ...(model === undefined ? {} : { model }),
      ...(allowedNames === undefined ? {} : { allowedNames }),
    });
    return;
  }
  if (!event.executionId) return;
  const execution = state.executions.get(event.executionId);
  if (!execution) return;
  if (event.type === 'execution/started') {
    execution.status = 'STARTED';
    return;
  }
  if (event.type === 'execution/completed') {
    execution.status = 'COMPLETED';
    execution.result = payload.result;
    applyCompletedMessages(state, event, payload);
    return;
  }
  if (event.type === 'execution/failed') {
    execution.status = 'FAILED';
    execution.error = payload.error;
    return;
  }
  if (event.type === 'execution/cancelled') {
    execution.status = 'CANCELLED';
    return;
  }
  if (event.type === 'execution/interrupted_detected') {
    execution.status = 'INTERRUPTED';
    execution.interrupted = true;
    return;
  }
  if (event.type === 'user/message') {
    // Stored for audit; model history built from completed execution bundle.
    return;
  }
}

function applyCompletedMessages(
  state: ProjectionState,
  event: SessionEventEnvelope,
  payload: Record<string, unknown>,
): void {
  const context = asOptionalRecord(payload.context);
  // Authoritative full snapshot replaces prior Message Projection entirely.
  if (context && Array.isArray(context.messages)) {
    const list: MessageProjectionItem[] = [];
    for (const raw of context.messages) {
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        continue;
      const message = raw as Record<string, unknown>;
      const role = message.role;
      if (role !== 'user' && role !== 'assistant' && role !== 'tool') continue;
      list.push({
        role,
        ...(message.content === undefined
          ? {}
          : { content: message.content as string }),
        ...(message.toolCallId === undefined
          ? {}
          : { toolCallId: String(message.toolCallId) }),
        ...(message.toolCalls === undefined
          ? {}
          : { toolCalls: message.toolCalls }),
        ...(message.isError === undefined
          ? {}
          : { isError: Boolean(message.isError) }),
        executionId: event.executionId!,
      });
    }
    state.messagesBySession.set(event.sessionId, list);
    const session = state.sessions.get(event.sessionId);
    if (session) {
      session.messagesAuthoritative = true;
      // Full-replace: omit data when the snapshot has none.
      const data = asOptionalRecord(context.data);
      if (data === undefined) {
        delete session.committedContextData;
      } else {
        session.committedContextData = structuredClone(data);
      }
    }
    return;
  }
  // Legacy append-only deltas (pre-authoritative context payload).
  const list = state.messagesBySession.get(event.sessionId) ?? [];
  const messages = Array.isArray(payload.messages)
    ? (payload.messages as MessageProjectionItem[])
    : [];
  for (const message of messages) {
    list.push({ ...message, executionId: event.executionId! });
  }
  state.messagesBySession.set(event.sessionId, list);
}

function markInterruptedExecutions(state: ProjectionState): void {
  for (const execution of state.executions.values()) {
    if (execution.status === 'CREATED' || execution.status === 'STARTED') {
      execution.status = 'INTERRUPTED';
      execution.interrupted = true;
      execution.needsInterruptPersist = true;
    }
  }
}

function applyWorkspaceSafety(state: ProjectionState): void {
  for (const workspace of state.workspaces.values()) {
    if (workspace.removed) continue;
    if (workspace.openIntents.size > 0) workspace.safety = 'UNSAFE';
  }
}

function deriveWorkspaceRefs(state: ProjectionState): void {
  state.workspaceSessionRefs.clear();
  for (const session of state.sessions.values()) {
    if (session.removed || !session.workspaceId) continue;
    const set =
      state.workspaceSessionRefs.get(session.workspaceId) ?? new Set();
    set.add(session.sessionId);
    state.workspaceSessionRefs.set(session.workspaceId, set);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asInitialContext(
  value: unknown,
): { messages: unknown[]; data?: Record<string, unknown> } | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as { messages?: unknown; data?: unknown };
  const messages = record.messages;
  if (!Array.isArray(messages)) return undefined;
  const data = asOptionalRecord(record.data);
  return {
    messages: [...messages],
    ...(data === undefined ? {} : { data: structuredClone(data) }),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string');
}
