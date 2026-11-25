import { WorkspaceError } from './errors.ts';
import type { WorkspaceAccess, WorkspaceSafety } from './types.ts';

interface Waiter {
  readonly access: 'read' | 'write';
  readonly resolve: () => void;
  readonly reject: (error: WorkspaceError) => void;
  readonly onAbort: () => void;
}

interface Gate {
  readers: number;
  writer: boolean;
  safety: WorkspaceSafety;
  queue: Waiter[];
}

export interface RunAccessOptions<T> {
  workspaceId: string;
  access: WorkspaceAccess;
  signal?: AbortSignal;
  task: () => Promise<T> | T;
}

/** Per-workspace read/write lock with write preference and UNSAFE gating. */
export class WorkspaceAccessCoordinator {
  private readonly gates = new Map<string, Gate>();

  safety(workspaceId: string): WorkspaceSafety {
    return this.gate(workspaceId).safety;
  }

  markUnsafe(workspaceId: string): void {
    this.gate(workspaceId).safety = 'UNSAFE';
    this.rejectQueued(workspaceId, new WorkspaceError('unsafe'));
  }

  recover(workspaceId: string): void {
    const gate = this.gate(workspaceId);
    if (gate.safety !== 'UNSAFE') return;
    gate.safety = 'NORMAL';
  }

  forget(workspaceId: string): void {
    const gate = this.gates.get(workspaceId);
    if (!gate) return;
    this.rejectQueued(
      workspaceId,
      new WorkspaceError('not_found', 'Workspace was removed.'),
    );
    this.gates.delete(workspaceId);
  }

  async run<T>(options: RunAccessOptions<T>): Promise<T> {
    const { workspaceId, access, signal, task } = options;
    if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
      throw new WorkspaceError('invalid_request');
    }
    if (access !== 'none' && access !== 'read' && access !== 'write') {
      throw new WorkspaceError('invalid_request');
    }
    if (typeof task !== 'function') throw new WorkspaceError('invalid_request');
    if (signal?.aborted) throw new WorkspaceError('cancelled');

    if (access === 'none') {
      this.assertSafe(workspaceId);
      return await task();
    }

    await this.acquire(workspaceId, access, signal);
    try {
      this.assertSafe(workspaceId);
      if (signal?.aborted) throw new WorkspaceError('cancelled');
      return await task();
    } finally {
      this.release(workspaceId, access);
    }
  }

  private assertSafe(workspaceId: string): void {
    if (this.gate(workspaceId).safety === 'UNSAFE') {
      throw new WorkspaceError('unsafe');
    }
  }

  private gate(workspaceId: string): Gate {
    let gate = this.gates.get(workspaceId);
    if (!gate) {
      gate = { readers: 0, writer: false, safety: 'NORMAL', queue: [] };
      this.gates.set(workspaceId, gate);
    }
    return gate;
  }

  private async acquire(
    workspaceId: string,
    access: 'read' | 'write',
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const gate = this.gate(workspaceId);
    if (gate.safety === 'UNSAFE') throw new WorkspaceError('unsafe');
    if (signal?.aborted) throw new WorkspaceError('cancelled');

    if (this.tryEnter(gate, access)) return;

    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        access,
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        onAbort: () => {
          const index = gate.queue.indexOf(waiter);
          if (index >= 0) gate.queue.splice(index, 1);
          waiter.reject(new WorkspaceError('cancelled'));
        },
      };
      const cleanup = () => {
        signal?.removeEventListener('abort', waiter.onAbort);
      };
      if (signal?.aborted) {
        reject(new WorkspaceError('cancelled'));
        return;
      }
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      gate.queue.push(waiter);
    });
  }

  private tryEnter(gate: Gate, access: 'read' | 'write'): boolean {
    if (!this.canEnter(gate, access)) return false;
    if (access === 'write') gate.writer = true;
    else gate.readers += 1;
    return true;
  }

  private canEnter(gate: Gate, access: 'read' | 'write'): boolean {
    if (access === 'write') return gate.readers === 0 && !gate.writer;
    const writerWaiting = gate.queue.some((item) => item.access === 'write');
    return !gate.writer && !writerWaiting;
  }

  private release(workspaceId: string, access: 'read' | 'write'): void {
    const gate = this.gates.get(workspaceId);
    if (!gate) return;
    if (access === 'write') gate.writer = false;
    else if (gate.readers > 0) gate.readers -= 1;
    this.pump(gate);
  }

  private pump(gate: Gate): void {
    for (;;) {
      const next = gate.queue[0];
      if (!next) return;
      if (!this.canEnter(gate, next.access)) return;
      gate.queue.shift();
      if (next.access === 'write') gate.writer = true;
      else gate.readers += 1;
      next.resolve();
      if (next.access === 'write') return;
    }
  }

  private rejectQueued(workspaceId: string, error: WorkspaceError): void {
    const gate = this.gates.get(workspaceId);
    if (!gate) return;
    const pending = gate.queue.splice(0);
    for (const waiter of pending) waiter.reject(error);
  }
}
