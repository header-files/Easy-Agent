import fs from 'node:fs/promises';
import { PersistenceError } from './errors.ts';
import {
  appendLineDurable,
  stableStringify,
  type DurableFsHooks,
} from './durable-fs.ts';

export interface JsonlReadResult<T> {
  records: T[];
  /** True when a trailing incomplete line was discarded. */
  truncatedTail: boolean;
}

/**
 * Read JSONL records. Incomplete trailing line is truncated (durable rewrite of
 * the truncated file) and reported. Mid-file corrupt / unparsable lines fail closed.
 */
export async function readJsonlFile<T>(
  filePath: string,
  parse: (value: unknown) => T,
): Promise<JsonlReadResult<T>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { records: [], truncatedTail: false };
    }
    throw new PersistenceError('io_failed');
  }
  if (raw.length === 0) return { records: [], truncatedTail: false };

  const endsWithNewline = raw.endsWith('\n');
  const parts = raw.split('\n');
  if (endsWithNewline && parts[parts.length - 1] === '') parts.pop();

  let truncatedTail = false;
  if (!endsWithNewline && parts.length > 0) {
    // Drop incomplete trailing line and rewrite file without it.
    parts.pop();
    truncatedTail = true;
    const repaired = parts.length === 0 ? '' : `${parts.join('\n')}\n`;
    await fs.writeFile(filePath, repaired, 'utf8');
    const handle = await fs.open(filePath, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  const records: T[] = [];
  for (let index = 0; index < parts.length; index++) {
    const line = parts[index]!;
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      throw new PersistenceError(
        'corrupt_store',
        `Unparseable JSONL record at line ${index + 1}.`,
      );
    }
    try {
      records.push(parse(value));
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError(
        'invalid_record',
        `Invalid JSONL record at line ${index + 1}.`,
      );
    }
  }
  return { records, truncatedTail };
}

export async function appendJsonlRecord(
  filePath: string,
  record: unknown,
  hooks?: DurableFsHooks,
): Promise<void> {
  await appendLineDurable(filePath, stableStringify(record), hooks);
}

/** Find a record by id; conflict if same id with different content. */
export function findById<T extends { id: string }>(
  records: readonly T[],
  id: string,
  expected?: T,
): T | undefined {
  const matches = records.filter((item) => item.id === id);
  if (matches.length === 0) return undefined;
  if (matches.length > 1) {
    throw new PersistenceError('conflict', `Duplicate record id ${id}.`);
  }
  const found = matches[0]!;
  if (
    expected !== undefined &&
    stableStringify(found) !== stableStringify(expected)
  ) {
    throw new PersistenceError('conflict', `Record id ${id} content mismatch.`);
  }
  return found;
}
