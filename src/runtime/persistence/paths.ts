import path from 'node:path';
import { PersistenceError } from './errors.ts';

export interface PersistenceLayout {
  root: string;
  journalDir: string;
  journalFile: string;
  sessionsDir: string;
  workspacesDir: string;
  workspaceRegistryFile: string;
  lockFile: string;
}

/** Single path segment only — blocks `../` and absolute injection into dataDir. */
const SAFE_SESSION_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function resolveLayout(dataRoot: string): PersistenceLayout {
  const root = path.resolve(dataRoot);
  const journalDir = path.join(root, 'journal');
  const sessionsDir = path.join(root, 'sessions');
  const workspacesDir = path.join(root, 'workspaces');
  return {
    root,
    journalDir,
    journalFile: path.join(journalDir, 'transactions.jsonl'),
    sessionsDir,
    workspacesDir,
    workspaceRegistryFile: path.join(workspacesDir, 'registry.jsonl'),
    lockFile: path.join(root, '.write.lock'),
  };
}

/**
 * Reject Session IDs that could escape `sessions/` via path traversal.
 * Allowed: letters, digits, `.`, `_`, `-` (covers UUID).
 */
export function assertSafeSessionStorageId(sessionId: string): void {
  if (
    typeof sessionId !== 'string' ||
    sessionId.length === 0 ||
    sessionId.length > 200 ||
    sessionId === '.' ||
    sessionId === '..' ||
    !SAFE_SESSION_SEGMENT.test(sessionId)
  ) {
    throw new PersistenceError(
      'invalid_request',
      'Session id is not a safe persistence storage key.',
    );
  }
}

export function sessionEventsPath(
  layout: PersistenceLayout,
  sessionId: string,
): string {
  assertSafeSessionStorageId(sessionId);
  const sessionDir = path.resolve(layout.sessionsDir, sessionId);
  const relative = path.relative(path.resolve(layout.sessionsDir), sessionDir);
  if (
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).length !== 1
  ) {
    throw new PersistenceError(
      'invalid_request',
      'Session event path would escape the data directory.',
    );
  }
  return path.join(sessionDir, 'events.jsonl');
}
