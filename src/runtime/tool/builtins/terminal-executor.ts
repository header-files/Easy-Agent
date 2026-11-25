import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { WorkspaceError } from '../../workspace/errors.ts';
import { MAX_TERMINAL_OUTPUT_BYTES } from './limits.ts';

export interface TerminalRunRequest {
  command: string;
  cwd: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Injected for tests: force cleanup uncertainty after kill. */
  forceCleanupUncertain?: boolean;
  onCleanupUncertain?: () => void;
}

export interface TerminalRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  cancelled: boolean;
}

export interface TerminalExecutorOptions {
  shell?: string;
  shellArgs?: readonly string[];
  maxOutputBytes?: number;
  killGraceMs?: number;
  /** How often to poll the process group after the shell exits. */
  descendantPollMs?: number;
}

function defaultShell(): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    const shell = process.env.ComSpec?.trim() || '';
    if (!shell) {
      throw new WorkspaceError(
        'invalid_request',
        'Windows ComSpec is missing; cannot start cmd.exe.',
      );
    }
    return { shell, args: ['/d', '/s', '/c'] };
  }
  return { shell: '/bin/sh', args: ['-c'] };
}

export class TerminalExecutor {
  private readonly shell: string;
  private readonly shellArgs: readonly string[];
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;
  private readonly descendantPollMs: number;

  constructor(options: TerminalExecutorOptions = {}) {
    const defaults = defaultShell();
    this.shell = options.shell ?? defaults.shell;
    this.shellArgs = options.shellArgs ?? defaults.args;
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_TERMINAL_OUTPUT_BYTES;
    this.killGraceMs = options.killGraceMs ?? 2_000;
    this.descendantPollMs = options.descendantPollMs ?? 50;
  }

  getShell(): string {
    return this.shell;
  }

  async run(request: TerminalRunRequest): Promise<TerminalRunResult> {
    if (
      typeof request.command !== 'string' ||
      request.command.trim().length === 0
    ) {
      throw new WorkspaceError('invalid_request');
    }
    if (typeof request.cwd !== 'string' || request.cwd.length === 0) {
      throw new WorkspaceError('invalid_request');
    }
    if (request.signal?.aborted) {
      throw new WorkspaceError('cancelled');
    }

    const runStarted = performance.now();
    // detached → own process group on POSIX so we can wait/kill descendants by pgid.
    const child = spawn(this.shell, [...this.shellArgs, request.command], {
      cwd: request.cwd,
      env: process.env,
      windowsHide: true,
      detached: process.platform !== 'win32',
    }) as ChildProcessWithoutNullStreams;

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;

    const collect = (
      stream: NodeJS.ReadableStream,
      chunks: Buffer[],
      which: 'stdout' | 'stderr',
    ) => {
      stream.on('data', (chunk: Buffer) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const current = which === 'stdout' ? stdoutBytes : stderrBytes;
        if (current >= this.maxOutputBytes) {
          truncated = true;
          return;
        }
        const room = this.maxOutputBytes - current;
        if (buf.length > room) {
          chunks.push(buf.subarray(0, room));
          truncated = true;
          if (which === 'stdout') stdoutBytes = this.maxOutputBytes;
          else stderrBytes = this.maxOutputBytes;
        } else {
          chunks.push(buf);
          if (which === 'stdout') stdoutBytes += buf.length;
          else stderrBytes += buf.length;
        }
      });
    };
    collect(child.stdout, stdoutChunks, 'stdout');
    collect(child.stderr, stderrChunks, 'stderr');

    let timedOut = false;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let stopping: Promise<void> | undefined;

    const stop = (reason: 'timeout' | 'cancel'): Promise<void> => {
      if (reason === 'timeout') timedOut = true;
      else cancelled = true;
      stopping ??= this.terminate(child, request).catch((error: unknown) => {
        if (error instanceof WorkspaceError) throw error;
        request.onCleanupUncertain?.();
        throw new WorkspaceError(
          'unsafe',
          'Terminal cleanup could not be confirmed.',
        );
      });
      return stopping;
    };

    if (request.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        void stop('timeout');
      }, request.timeoutMs);
    }
    if (request.signal) {
      onAbort = () => {
        void stop('cancel');
      };
      if (request.signal.aborted) await stop('cancel');
      else request.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const [code, signal] = (await once(child, 'exit')) as [
        number | null,
        NodeJS.Signals | null,
      ];
      // Always wait for in-flight terminate/UNSAFE before returning to the lock holder.
      if (stopping) await stopping;
      if (request.forceCleanupUncertain) {
        request.onCleanupUncertain?.();
        throw new WorkspaceError(
          'unsafe',
          'Terminal cleanup could not be confirmed.',
        );
      }
      // Shell exit alone is not enough: background jobs in the process group may
      // still write after the lock would otherwise be released.
      if (!stopping && child.pid !== undefined) {
        const pending = await this.awaitProcessGroupIdle(
          child.pid,
          request,
          runStarted,
        );
        if (pending === 'timeout') {
          timedOut = true;
          await stop('timeout');
        } else if (pending === 'cancel') {
          cancelled = true;
          await stop('cancel');
        }
      } else if (stopping) {
        await stopping;
      }
      return {
        exitCode: code,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        truncated,
        timedOut,
        cancelled,
      };
    } catch (error) {
      if (error instanceof WorkspaceError) throw error;
      try {
        await stop(request.signal?.aborted ? 'cancel' : 'timeout');
      } catch (cleanupError) {
        if (cleanupError instanceof WorkspaceError) throw cleanupError;
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort && request.signal) {
        request.signal.removeEventListener('abort', onAbort);
      }
    }
  }

  /**
   * After the shell exits, wait until the POSIX process group has no members.
   * Returns `timeout`/`cancel` when the caller should run terminate; `idle` when clear.
   * Windows tree detection is best-effort (shell PID only) until native CI lands.
   */
  private async awaitProcessGroupIdle(
    pgid: number,
    request: TerminalRunRequest,
    runStarted: number,
  ): Promise<'idle' | 'timeout' | 'cancel'> {
    while (await processGroupHasMembers(pgid)) {
      if (request.signal?.aborted) return 'cancel';
      if (
        request.timeoutMs !== undefined &&
        performance.now() - runStarted >= request.timeoutMs
      ) {
        return 'timeout';
      }
      await delay(this.descendantPollMs);
    }
    return 'idle';
  }

  private async killProcessGroup(
    pgid: number,
    request: TerminalRunRequest,
  ): Promise<void> {
    if (process.platform === 'win32') {
      await windowsKillTree(pgid);
    } else {
      try {
        process.kill(-pgid, 'SIGTERM');
      } catch {
        /* ESRCH: already gone */
      }
      await delay(this.killGraceMs);
      if (await processGroupHasMembers(pgid)) {
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch {
          /* ESRCH */
        }
        await delay(200);
      }
    }
    if (await processGroupHasMembers(pgid)) {
      request.onCleanupUncertain?.();
      throw new WorkspaceError(
        'unsafe',
        'Terminal cleanup could not be confirmed.',
      );
    }
  }

  private async terminate(
    child: ChildProcessWithoutNullStreams,
    request: TerminalRunRequest,
  ): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      // Shell already gone — still reap any process-group descendants.
      if (child.pid !== undefined) {
        await this.killProcessGroup(child.pid, request);
      } else if (request.forceCleanupUncertain) {
        request.onCleanupUncertain?.();
        throw new WorkspaceError(
          'unsafe',
          'Terminal cleanup could not be confirmed.',
        );
      }
      return;
    }
    try {
      if (process.platform === 'win32') {
        if (child.pid) await windowsKillTree(child.pid);
      } else if (child.pid) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
        await delay(this.killGraceMs);
        if (child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
        }
      }
    } catch {
      request.onCleanupUncertain?.();
      throw new WorkspaceError(
        'unsafe',
        'Terminal cleanup could not be confirmed.',
      );
    }

    const closed = await waitExit(child, 3_000);
    if (!closed || request.forceCleanupUncertain) {
      request.onCleanupUncertain?.();
      throw new WorkspaceError(
        'unsafe',
        'Terminal cleanup could not be confirmed.',
      );
    }
    if (child.pid !== undefined && (await processGroupHasMembers(child.pid))) {
      await this.killProcessGroup(child.pid, request);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitExit(
  child: ChildProcessWithoutNullStreams,
  ms: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await Promise.race([
    once(child, 'exit').then(() => true),
    delay(ms).then(() => false),
  ]);
}

/** True if any process remains in the managed group / tree. */
async function processGroupHasMembers(pgid: number): Promise<boolean> {
  if (process.platform === 'win32') {
    return windowsTreeHasProcesses(pgid);
  }
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    // EPERM etc.: something exists we cannot signal — treat as still running.
    return true;
  }
}

async function windowsKillTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.on('exit', () => resolve());
    killer.on('error', () => resolve());
  });
}

async function windowsTreeHasProcesses(pid: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const checker = spawn(
      'tasklist',
      ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    let out = '';
    checker.stdout?.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
    });
    checker.on('exit', () => {
      // tasklist prints "INFO: No tasks..." when missing; CSV with pid when present.
      resolve(out.includes(`"${pid}"`) || out.includes(String(pid)));
    });
    checker.on('error', () => resolve(true));
  });
}
