import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { WorkspaceError } from './errors.ts';
import {
  normalizeIdentity,
  resolveCreatableDirectory,
  resolveExistingDirectory,
  rootsOverlap,
} from './path-identity.ts';
import type { Workspace, WorkspaceStatus } from './types.ts';
import type { WorkspaceAccessCoordinator } from './access-coordinator.ts';
// type-only import keeps manager free of runtime cycles with the coordinator.

export interface WorkspaceManagerOptions {
  coordinator?: WorkspaceAccessCoordinator;
}

export class WorkspaceManager {
  private readonly workspaces = new Map<
    string,
    { workspace: Workspace; sessionRefs: Set<string> }
  >();
  private defaultId: string | undefined;
  private readonly coordinator: WorkspaceAccessCoordinator | undefined;

  constructor(options: WorkspaceManagerOptions = {}) {
    this.coordinator = options.coordinator;
  }

  async register(name: string, existingDirectory: string): Promise<Workspace> {
    this.validName(name);
    const rootPath = await resolveExistingDirectory(existingDirectory);
    this.assertNoOverlap(rootPath);
    return this.insert(name, rootPath);
  }

  async create(name: string, newDirectory: string): Promise<Workspace> {
    this.validName(name);
    const { rootPath, absolute } =
      await resolveCreatableDirectory(newDirectory);
    this.assertNoOverlap(rootPath);
    await fs.mkdir(absolute, { recursive: false });
    let real: string;
    try {
      real = normalizeIdentity(await fs.realpath(absolute));
    } catch {
      throw new WorkspaceError('invalid_path');
    }
    this.assertNoOverlap(real);
    return this.insert(name, real);
  }

  get(id: string): Workspace | undefined {
    return this.workspaces.get(id)?.workspace;
  }

  list(): readonly Workspace[] {
    return [...this.workspaces.values()].map((entry) => entry.workspace);
  }

  status(id: string): WorkspaceStatus {
    const entry = this.workspaces.get(id);
    if (!entry) throw new WorkspaceError('not_found');
    return {
      ...entry.workspace,
      safety: this.coordinator?.safety(id) ?? 'NORMAL',
      sessionRefs: entry.sessionRefs.size,
    };
  }

  setDefault(id: string): void {
    if (!this.workspaces.has(id)) throw new WorkspaceError('not_found');
    this.defaultId = id;
  }

  getDefault(): Workspace | undefined {
    return this.defaultId === undefined
      ? undefined
      : this.workspaces.get(this.defaultId)?.workspace;
  }

  /** Bind a session to a workspace; returns false if workspace missing. */
  bindSession(workspaceId: string, sessionId: string): boolean {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new WorkspaceError('invalid_request');
    }
    const entry = this.workspaces.get(workspaceId);
    if (!entry) return false;
    entry.sessionRefs.add(sessionId);
    return true;
  }

  unbindSession(workspaceId: string, sessionId: string): void {
    this.workspaces.get(workspaceId)?.sessionRefs.delete(sessionId);
  }

  unbindSessionEverywhere(sessionId: string): void {
    for (const entry of this.workspaces.values()) {
      entry.sessionRefs.delete(sessionId);
    }
  }

  remove(id: string): boolean {
    const entry = this.workspaces.get(id);
    if (!entry) return false;
    if (entry.sessionRefs.size > 0) throw new WorkspaceError('in_use');
    this.workspaces.delete(id);
    if (this.defaultId === id) {
      this.defaultId = this.workspaces.keys().next().value;
    }
    this.coordinator?.forget(id);
    return true;
  }

  private insert(name: string, rootPath: string): Workspace {
    for (const entry of this.workspaces.values()) {
      if (entry.workspace.name === name) {
        throw new WorkspaceError(
          'invalid_request',
          'Workspace name is already registered.',
        );
      }
    }
    const workspace: Workspace = Object.freeze({
      id: randomUUID(),
      name,
      rootPath,
    });
    this.workspaces.set(workspace.id, {
      workspace,
      sessionRefs: new Set(),
    });
    if (this.defaultId === undefined) this.defaultId = workspace.id;
    return workspace;
  }

  private assertNoOverlap(rootPath: string): void {
    for (const entry of this.workspaces.values()) {
      if (rootsOverlap(entry.workspace.rootPath, rootPath)) {
        throw new WorkspaceError('overlap');
      }
    }
  }

  private validName(name: string): void {
    if (
      typeof name !== 'string' ||
      name.trim().length === 0 ||
      name.length > 128
    ) {
      throw new WorkspaceError('invalid_request');
    }
  }
}
