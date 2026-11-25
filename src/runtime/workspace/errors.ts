export type WorkspaceErrorCode =
  | 'not_found'
  | 'invalid_path'
  | 'overlap'
  | 'in_use'
  | 'unsafe'
  | 'exists'
  | 'not_directory'
  | 'cancelled'
  | 'invalid_request';

const messages: Record<WorkspaceErrorCode, string> = {
  not_found: 'Workspace was not found.',
  invalid_path: 'Workspace path is invalid.',
  overlap: 'Workspace root overlaps an existing workspace.',
  in_use: 'Workspace is still referenced by a session.',
  unsafe:
    'Workspace is unsafe after uncertain process cleanup; recover explicitly after inspection.',
  exists: 'Workspace path already exists and cannot be created.',
  not_directory: 'Workspace path is not an existing directory.',
  cancelled: 'Workspace access was cancelled.',
  invalid_request: 'Workspace request is invalid.',
};

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message = messages[code]) {
    super(message);
    this.name = 'WorkspaceError';
    this.code = code;
  }
}
