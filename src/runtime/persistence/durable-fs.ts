import fs from 'node:fs/promises';
import path from 'node:path';
import { PersistenceError } from './errors.ts';

/** Owner-only access for data directories that may hold Tool/LLM transcripts. */
export const PRIVATE_DIR_MODE = 0o700;
/** Owner-only access for journal / event / registry files. */
export const PRIVATE_FILE_MODE = 0o600;

export interface DurableFsHooks {
  /** Test injection: fail after bytes are written but before sync. */
  failBeforeSync?: boolean;
  /**
   * Test injection: fail before sync only when the payload includes this
   * substring (e.g. `"state":"COMMITTED"` after Operations are written).
   */
  failBeforeSyncIfLineIncludes?: string;
  /**
   * Test injection: fail before sync only when the absolute file path includes
   * this substring (e.g. `/sessions/` for Event Log Operations only).
   */
  failBeforeSyncIfPathIncludes?: string;
  /** Test injection: truncate after write to simulate partial durability. */
  truncateAfterWrite?: boolean;
}

async function chmodBestEffort(target: string, mode: number): Promise<void> {
  try {
    await fs.chmod(target, mode);
  } catch {
    /* Windows and some filesystems may ignore or reject mode bits. */
  }
}

/** Ensure parent directories exist (mode 0700) and fsync the leaf directory when possible. */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmodBestEffort(dirPath, PRIVATE_DIR_MODE);
  try {
    const handle = await fs.open(dirPath, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    /* Directory sync is best-effort on platforms that reject it. */
  }
}

/** Append one UTF-8 line and fsync the file (and optionally the parent dir). */
export async function appendLineDurable(
  filePath: string,
  line: string,
  hooks: DurableFsHooks = {},
): Promise<void> {
  const payload = line.endsWith('\n') ? line : `${line}\n`;
  await ensureDir(path.dirname(filePath));
  let handle;
  try {
    handle = await fs.open(filePath, 'a', PRIVATE_FILE_MODE);
  } catch {
    throw new PersistenceError('io_failed');
  }
  try {
    await handle.writeFile(payload, 'utf8');
    await chmodBestEffort(filePath, PRIVATE_FILE_MODE);
    if (hooks.truncateAfterWrite) {
      const stat = await handle.stat();
      await handle.truncate(Math.max(0, Number(stat.size) - 1));
    }
    if (hooks.failBeforeSync) {
      throw new PersistenceError('commit_uncertain');
    }
    if (
      hooks.failBeforeSyncIfLineIncludes !== undefined &&
      payload.includes(hooks.failBeforeSyncIfLineIncludes)
    ) {
      throw new PersistenceError('commit_uncertain');
    }
    if (
      hooks.failBeforeSyncIfPathIncludes !== undefined &&
      filePath.includes(hooks.failBeforeSyncIfPathIncludes)
    ) {
      throw new PersistenceError('commit_uncertain');
    }
    await handle.sync();
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    throw new PersistenceError('io_failed');
  } finally {
    await handle.close().catch(() => {});
  }
  try {
    const parent = await fs.open(path.dirname(filePath), 'r');
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } catch {
    /* Parent sync best-effort. */
  }
}

/**
 * Deterministic JSON serialization for durable records (sorted object keys).
 * Only JSON-safe values are accepted — Date/Map/Set/class instances/undefined/
 * non-finite numbers are rejected so callers cannot report success after data loss.
 */
export function stableStringify(value: unknown): string {
  assertDurableJsonValue(value);
  return JSON.stringify(sortValue(value));
}

/**
 * Persistence Event Log / Journal payload must round-trip through JSON without
 * changing meaning. In-memory Agent context may still hold richer values; they
 * must be converted or omitted before a durable commit is attempted.
 */
export function assertDurableJsonValue(value: unknown, path = '$'): void {
  if (value === null) return;
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return;
  if (kind === 'number') {
    if (!Number.isFinite(value)) {
      throw new PersistenceError(
        'invalid_record',
        `Non-finite number is not durable JSON at ${path}.`,
      );
    }
    return;
  }
  if (kind !== 'object') {
    throw new PersistenceError(
      'invalid_record',
      `Value type ${kind} is not durable JSON at ${path}.`,
    );
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      assertDurableJsonValue(value[index], `${path}[${index}]`);
    }
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new PersistenceError(
      'invalid_record',
      `Only plain JSON objects are durable; unsupported value at ${path}.`,
    );
  }
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const nested = (value as Record<string, unknown>)[key];
    if (nested === undefined) {
      throw new PersistenceError(
        'invalid_record',
        `Undefined property is not durable JSON at ${path}.${key}.`,
      );
    }
    assertDurableJsonValue(nested, `${path}.${key}`);
  }
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortValue);
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    out[key] = sortValue(record[key]);
  }
  return out;
}
