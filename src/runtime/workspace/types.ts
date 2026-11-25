export type WorkspaceAccess = 'none' | 'read' | 'write';

export type WorkspaceSafety = 'NORMAL' | 'UNSAFE';

export interface Workspace {
  readonly id: string;
  readonly name: string;
  /** Realpath-normalized absolute root; comparison identity for locks. */
  readonly rootPath: string;
}

export interface WorkspaceStatus extends Workspace {
  readonly safety: WorkspaceSafety;
  readonly sessionRefs: number;
}
