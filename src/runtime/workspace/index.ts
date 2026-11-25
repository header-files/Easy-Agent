export { WorkspaceError, type WorkspaceErrorCode } from './errors.ts';
export type {
  Workspace,
  WorkspaceAccess,
  WorkspaceSafety,
  WorkspaceStatus,
} from './types.ts';
export {
  normalizeIdentity,
  resolveCreatableDirectory,
  resolveExistingDirectory,
  rootsOverlap,
} from './path-identity.ts';
export { WorkspaceManager } from './workspace-manager.ts';
export {
  WorkspaceAccessCoordinator,
  type RunAccessOptions,
} from './access-coordinator.ts';
export { WorkspacePathResolver, type ResolvedPath } from './path-resolver.ts';
