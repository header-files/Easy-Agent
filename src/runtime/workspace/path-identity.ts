import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceError } from './errors.ts';

/** Normalize a candidate root for identity/overlap checks without following final missing path. */
export async function resolveExistingDirectory(input: string): Promise<string> {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new WorkspaceError('invalid_path');
  }
  let absolute: string;
  try {
    absolute = path.resolve(input);
  } catch {
    throw new WorkspaceError('invalid_path');
  }
  let real: string;
  try {
    real = await fs.realpath(absolute);
  } catch {
    throw new WorkspaceError('not_directory');
  }
  let stats;
  try {
    stats = await fs.lstat(real);
  } catch {
    throw new WorkspaceError('not_directory');
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new WorkspaceError('not_directory');
  }
  return normalizeIdentity(real);
}

/** Create parent-safe new directory path identity; path must not already exist. */
export async function resolveCreatableDirectory(
  input: string,
): Promise<{ rootPath: string; absolute: string }> {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new WorkspaceError('invalid_path');
  }
  let absolute: string;
  try {
    absolute = path.resolve(input);
  } catch {
    throw new WorkspaceError('invalid_path');
  }
  try {
    await fs.lstat(absolute);
    throw new WorkspaceError('exists');
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new WorkspaceError('invalid_path');
    }
  }
  const parent = path.dirname(absolute);
  let parentReal: string;
  try {
    parentReal = await fs.realpath(parent);
  } catch {
    throw new WorkspaceError('invalid_path');
  }
  const parentStat = await fs.lstat(parentReal);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) {
    throw new WorkspaceError('invalid_path');
  }
  const rootPath = normalizeIdentity(
    path.join(parentReal, path.basename(absolute)),
  );
  return { rootPath, absolute: path.join(parentReal, path.basename(absolute)) };
}

export function normalizeIdentity(rootPath: string): string {
  const resolved = path.resolve(rootPath);
  if (process.platform === 'win32') {
    return resolved.replace(/\//g, '\\').toLowerCase();
  }
  return resolved;
}

/** True when a and b are the same root or one contains the other. */
export function rootsOverlap(a: string, b: string): boolean {
  const left = normalizeIdentity(a);
  const right = normalizeIdentity(b);
  if (left === right) return true;
  const sep = process.platform === 'win32' ? '\\' : '/';
  return (
    left.startsWith(right.endsWith(sep) ? right : right + sep) ||
    right.startsWith(left.endsWith(sep) ? left : left + sep)
  );
}
