import { randomBytes } from 'node:crypto';
import type { Stats } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceError } from '../../workspace/errors.ts';

/** O_NOFOLLOW when the platform provides it; otherwise 0 with explicit component checks. */
function noFollowFlag(): number {
  const flag = fs.constants.O_NOFOLLOW;
  return typeof flag === 'number' && flag !== 0 ? flag : 0;
}

function openFlags(base: number, extra: number = 0): number {
  return base | extra | noFollowFlag();
}

async function assertNotSymlinkHandle(handle: FileHandle): Promise<void> {
  const stat = await handle.stat();
  if (stat.isSymbolicLink()) {
    throw new WorkspaceError('invalid_path');
  }
}

/** Reject if any path component from root to leaf is a symlink / reparse link. */
export async function assertNoSymlinkComponents(
  rootPath: string,
  absolute: string,
): Promise<void> {
  const root = path.resolve(rootPath);
  const target = path.resolve(absolute);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new WorkspaceError('invalid_path');
  }
  const parts =
    relative === '' || relative === '.'
      ? []
      : relative.split(path.sep).filter((part) => part && part !== '.');
  let current = root;
  const rootStat = await fs.lstat(current);
  if (rootStat.isSymbolicLink()) throw new WorkspaceError('invalid_path');
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new WorkspaceError('invalid_path');
    }
    if (stat.isSymbolicLink()) throw new WorkspaceError('invalid_path');
  }
}

async function openVerified(
  absolute: string,
  flags: number,
  rootPath?: string,
): Promise<FileHandle> {
  if (rootPath !== undefined) {
    await assertNoSymlinkComponents(rootPath, absolute);
  } else if (noFollowFlag() === 0) {
    // Without O_NOFOLLOW, refuse opens that cannot prove link-free components.
    const leaf = await fs.lstat(absolute).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new WorkspaceError('invalid_path');
    });
    if (leaf?.isSymbolicLink()) throw new WorkspaceError('invalid_path');
  }
  try {
    const handle = await fs.open(absolute, flags);
    try {
      await assertNotSymlinkHandle(handle);
      return handle;
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new WorkspaceError('invalid_path');
    }
    throw error;
  }
}

/** Open an existing regular file for reading without following a final symlink. */
export async function openFileRead(
  absolute: string,
  rootPath?: string,
): Promise<FileHandle> {
  const handle = await openVerified(
    absolute,
    openFlags(fs.constants.O_RDONLY),
    rootPath,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      await handle.close();
      throw new Error('Path is not a file.');
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/** Open a directory for listing; rejects symlink directories when O_NOFOLLOW applies. */
export async function openDirRead(
  absolute: string,
  rootPath?: string,
): Promise<FileHandle> {
  const dirFlag =
    typeof fs.constants.O_DIRECTORY === 'number' ? fs.constants.O_DIRECTORY : 0;
  const handle = await openVerified(
    absolute,
    openFlags(fs.constants.O_RDONLY, dirFlag),
    rootPath,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) {
      await handle.close();
      throw new Error('Path is not a directory.');
    }
    return handle;
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/**
 * Ensure the path still names the same directory inode as an already-open handle.
 * Node cannot scandir by fd; callers must readdir(path) then call this so a
 * concurrent symlink/Junction replacement cannot return outside entries.
 */
export async function assertSameDirectory(
  absolute: string,
  expected: Stats,
): Promise<void> {
  let st: Stats;
  try {
    st = await fs.lstat(absolute);
  } catch {
    throw new WorkspaceError('invalid_path');
  }
  if (
    st.isSymbolicLink() ||
    !st.isDirectory() ||
    st.ino !== expected.ino ||
    st.dev !== expected.dev
  ) {
    throw new WorkspaceError('invalid_path');
  }
}

/**
 * List directory entry names bound to a nofollow-opened directory inode.
 * Holds the handle across readdir and rejects if the path was replaced.
 */
export async function listVerifiedDirectoryNames(
  absolute: string,
  rootPath: string,
): Promise<{ names: string[]; expected: Stats }> {
  const handle = await openDirRead(absolute, rootPath);
  try {
    const expected = await handle.stat();
    await assertSameDirectory(absolute, expected);
    const names = await fs.readdir(absolute);
    await assertSameDirectory(absolute, expected);
    return {
      names: names.filter((name) => name !== '.' && name !== '..'),
      expected,
    };
  } finally {
    await handle.close();
  }
}

/**
 * Create a new file exclusively (fails if it already exists) and write content.
 * Uses O_EXCL so a file appearing between check and create cannot be overwritten.
 */
export async function writeFileExclusive(
  absolute: string,
  content: string,
  rootPath?: string,
): Promise<void> {
  if (rootPath !== undefined) {
    await assertNoSymlinkComponents(rootPath, path.dirname(absolute));
  }
  let handle: FileHandle;
  try {
    handle = await fs.open(
      absolute,
      openFlags(
        fs.constants.O_WRONLY,
        fs.constants.O_CREAT | fs.constants.O_EXCL,
      ),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      throw new Error('File exists; set overwrite=true to replace.', {
        cause: error,
      });
    }
    if (code === 'ELOOP') {
      throw new WorkspaceError('invalid_path');
    }
    throw error;
  }
  try {
    await assertNotSymlinkHandle(handle);
    await handle.writeFile(content, 'utf8');
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(absolute).catch(() => {});
    throw error;
  }
  await handle.close();
}

/**
 * Replace an existing regular file by writing a sibling temp then renaming.
 * Failure before rename leaves the original file intact.
 */
export async function writeFileOverwrite(
  absolute: string,
  content: string,
  rootPath?: string,
): Promise<void> {
  if (rootPath !== undefined) {
    await assertNoSymlinkComponents(rootPath, absolute);
  }
  let existing;
  try {
    existing = await fs.lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('File was not found.', { cause: error });
    }
    throw error;
  }
  if (existing.isSymbolicLink() || !existing.isFile()) {
    throw new Error('Path is not a file.');
  }

  const temp = `${absolute}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}`;
  try {
    await writeFileExclusive(temp, content, rootPath);
    const again = await fs.lstat(absolute);
    if (again.isSymbolicLink() || !again.isFile()) {
      throw new WorkspaceError('invalid_path');
    }
    await fs.rename(temp, absolute);
  } catch (error) {
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

/** Read UTF-8 text via a nofollow open. */
export async function readFileText(
  absolute: string,
  maxBytes: number,
  rootPath?: string,
): Promise<string> {
  const handle = await openFileRead(absolute, rootPath);
  try {
    const stat = await handle.stat();
    if (stat.size > maxBytes) {
      throw new Error(`File exceeds ${maxBytes} byte read limit.`);
    }
    const buffer = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}
