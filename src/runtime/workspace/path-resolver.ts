import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceError } from './errors.ts';
import { normalizeIdentity } from './path-identity.ts';

export interface ResolvedPath {
  readonly absolute: string;
  readonly relative: string;
  readonly exists: boolean;
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

/**
 * Resolve a tool path inside a workspace root without following symlinks.
 * Any symlink / junction component causes rejection.
 */
export class WorkspacePathResolver {
  private readonly rootPath: string;

  constructor(rootPath: string) {
    if (typeof rootPath !== 'string' || rootPath.length === 0) {
      throw new WorkspaceError('invalid_path');
    }
    this.rootPath = rootPath;
  }

  async resolve(input: string): Promise<ResolvedPath> {
    if (typeof input !== 'string' || input.trim().length === 0) {
      throw new WorkspaceError('invalid_path');
    }
    if (input.includes('\0')) throw new WorkspaceError('invalid_path');
    if (
      process.platform === 'win32' &&
      input.includes(':') &&
      !path.isAbsolute(input)
    ) {
      // Reject ADS-like or drive-relative oddities that are not absolute roots.
      if (!/^[a-zA-Z]:[\\/]/.test(input)) {
        throw new WorkspaceError('invalid_path');
      }
    }

    const root = this.rootPath;
    const candidate = path.isAbsolute(input)
      ? path.resolve(input)
      : path.resolve(root, input);

    if (process.platform === 'win32') {
      const base = path.basename(candidate);
      if (WIN_RESERVED.test(base) || /[<>"|?*]/.test(candidate)) {
        throw new WorkspaceError('invalid_path');
      }
    }

    await this.assertComponentsNoSymlinks(root, candidate);
    this.assertInsideRoot(root, candidate);

    let exists = false;
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink()) throw new WorkspaceError('invalid_path');
      exists = true;
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new WorkspaceError('invalid_path');
      }
    }

    const relative = path.relative(root, candidate);
    if (
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      relative.includes(`..${path.sep}`)
    ) {
      throw new WorkspaceError('invalid_path');
    }

    return {
      absolute: candidate,
      relative: relative === '' ? '.' : relative,
      exists,
    };
  }

  private assertInsideRoot(root: string, candidate: string): void {
    const rootId = normalizeIdentity(root);
    const candidateId = normalizeIdentity(candidate);
    if (candidateId === rootId) return;
    const sep = process.platform === 'win32' ? '\\' : '/';
    const prefix = rootId.endsWith(sep) ? rootId : rootId + sep;
    if (!candidateId.startsWith(prefix)) {
      throw new WorkspaceError('invalid_path');
    }
  }

  private async assertComponentsNoSymlinks(
    root: string,
    candidate: string,
  ): Promise<void> {
    const rootResolved = path.resolve(root);
    const target = path.resolve(candidate);
    const relative = path.relative(rootResolved, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      // Still walk absolute candidates that claim to be inside after normalize.
      this.assertInsideRoot(rootResolved, target);
    }
    const parts =
      relative === '' || relative === '.'
        ? []
        : relative.split(path.sep).filter((part) => part && part !== '.');

    let current = rootResolved;
    const rootStat = await fs.lstat(current);
    if (rootStat.isSymbolicLink()) throw new WorkspaceError('invalid_path');

    for (const part of parts) {
      current = path.join(current, part);
      let stat;
      try {
        stat = await fs.lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          // Remaining parts are for a not-yet-created leaf; parents must exist.
          break;
        }
        throw new WorkspaceError('invalid_path');
      }
      if (stat.isSymbolicLink()) throw new WorkspaceError('invalid_path');
      // Windows junctions often report as directories with reparse; lstat isSymbolicLink
      // is true for symlinks; for junctions Node may also report isSymbolicLink.
      if (
        process.platform === 'win32' &&
        'isReparsePoint' in stat &&
        typeof (stat as { isReparsePoint?: () => boolean }).isReparsePoint ===
          'function' &&
        (stat as { isReparsePoint: () => boolean }).isReparsePoint()
      ) {
        throw new WorkspaceError('invalid_path');
      }
    }
  }
}
