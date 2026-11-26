/**
 * Coordinates Session create vs Workspace delete without using the Phase 2.2
 * file AccessCoordinator. Shared vs exclusive locks per workspace id.
 */
export class WorkspaceLifecycleCoordinator {
  private readonly shared = new Map<string, number>();
  private readonly exclusive = new Set<string>();
  private readonly waiters: Array<() => void> = [];

  async withShared<T>(workspaceId: string, work: () => Promise<T>): Promise<T> {
    await this.acquire(workspaceId, 'shared');
    try {
      return await work();
    } finally {
      this.release(workspaceId, 'shared');
    }
  }

  async withExclusive<T>(
    workspaceId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    await this.acquire(workspaceId, 'exclusive');
    try {
      return await work();
    } finally {
      this.release(workspaceId, 'exclusive');
    }
  }

  private async acquire(
    workspaceId: string,
    mode: 'shared' | 'exclusive',
  ): Promise<void> {
    for (;;) {
      if (mode === 'shared') {
        if (!this.exclusive.has(workspaceId)) {
          this.shared.set(workspaceId, (this.shared.get(workspaceId) ?? 0) + 1);
          return;
        }
      } else if (
        !this.exclusive.has(workspaceId) &&
        (this.shared.get(workspaceId) ?? 0) === 0
      ) {
        this.exclusive.add(workspaceId);
        return;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private release(workspaceId: string, mode: 'shared' | 'exclusive'): void {
    if (mode === 'shared') {
      const count = (this.shared.get(workspaceId) ?? 1) - 1;
      if (count <= 0) this.shared.delete(workspaceId);
      else this.shared.set(workspaceId, count);
    } else {
      this.exclusive.delete(workspaceId);
    }
    const pending = this.waiters.splice(0);
    for (const wake of pending) wake();
  }
}
