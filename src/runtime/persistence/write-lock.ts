import fs from 'node:fs/promises';
import { PersistenceError } from './errors.ts';
import { ensureDir, PRIVATE_FILE_MODE } from './durable-fs.ts';
import type { PersistenceLayout } from './paths.ts';

export interface WriteLock {
  release(): Promise<void>;
}

/**
 * Exclusive data-directory write lock via O_EXCL lock file.
 * Stale locks from dead PIDs on the same host are removed best-effort.
 */
export async function acquireWriteLock(
  layout: PersistenceLayout,
): Promise<WriteLock> {
  await ensureDir(layout.root);
  const payload = `${process.pid}\n${new Date().toISOString()}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await fs.open(layout.lockFile, 'wx', PRIVATE_FILE_MODE);
      try {
        await handle.writeFile(payload, 'utf8');
        try {
          await fs.chmod(layout.lockFile, PRIVATE_FILE_MODE);
        } catch {
          /* Mode bits are best-effort on some platforms. */
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      return {
        async release() {
          await fs.unlink(layout.lockFile).catch(() => {});
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new PersistenceError('lock_failed');
      }
      if (attempt === 0 && (await tryClearStaleLock(layout.lockFile))) continue;
      throw new PersistenceError(
        'lock_failed',
        'Another Easy Agent process holds the data directory write lock.',
      );
    }
  }
  throw new PersistenceError('lock_failed');
}

async function tryClearStaleLock(lockFile: string): Promise<boolean> {
  try {
    const text = await fs.readFile(lockFile, 'utf8');
    const pid = Number.parseInt(text.split('\n')[0] ?? '', 10);
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      await fs.unlink(lockFile);
      return true;
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        await fs.unlink(lockFile);
        return true;
      }
      return false;
    }
  } catch {
    return false;
  }
}
