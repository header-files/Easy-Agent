import type { WorkspaceAccess } from '../workspace/types.ts';

export type ToolApprovalPolicy = 'always' | 'never';

export interface ToolRuntimeMeta {
  readonly approval: ToolApprovalPolicy;
  readonly workspaceAccess: WorkspaceAccess;
}

export const DEFAULT_TOOL_META: ToolRuntimeMeta = Object.freeze({
  approval: 'always',
  workspaceAccess: 'none',
});

export function normalizeToolMeta(
  meta?: Partial<ToolRuntimeMeta>,
): ToolRuntimeMeta {
  const approval = meta?.approval ?? DEFAULT_TOOL_META.approval;
  const workspaceAccess =
    meta?.workspaceAccess ?? DEFAULT_TOOL_META.workspaceAccess;
  if (approval !== 'always' && approval !== 'never') {
    throw new Error('Invalid tool approval policy.');
  }
  if (
    workspaceAccess !== 'none' &&
    workspaceAccess !== 'read' &&
    workspaceAccess !== 'write'
  ) {
    throw new Error('Invalid tool workspace access.');
  }
  return Object.freeze({ approval, workspaceAccess });
}
