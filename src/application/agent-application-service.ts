import type {
  CreateSessionOptions,
  SessionExecution,
  SessionSubmitOptions,
  SessionSummary,
} from '../harness/contracts/agent/index.ts';
import type { ModelDescriptor } from '../harness/contracts/model/index.ts';
import type {
  ApprovalDecision,
  ApprovalRequest,
} from '../runtime/approval/index.ts';
import type { Workspace, WorkspaceStatus } from '../runtime/workspace/index.ts';

export interface SessionInfo {
  readonly sessionId: string;
}

/** Safe view of a committed/restored Execution for CLI and Application queries. */
export interface ExecutionInfo {
  readonly executionId: string;
  readonly sessionId: string;
  readonly status: string;
  readonly input?: string;
  readonly model?: string;
  readonly interrupted?: boolean;
  /** Present for completed executions when a durable result was recorded. */
  readonly result?: unknown;
  /** Present for failed executions when a durable error was recorded. */
  readonly error?: unknown;
}

/** Transport-neutral application entry; queue, context and execution stay in Agent. */
export interface AgentApplicationService {
  createSession(options?: CreateSessionOptions): Promise<SessionInfo>;
  listModels(): readonly ModelDescriptor[];
  getSessionModel(sessionId: string): string;
  setSessionModel(sessionId: string, modelId: string): Promise<void>;
  listSessions(): SessionSummary[];
  deleteSession(sessionId: string): Promise<boolean>;
  /** Historical / restored Executions for a Session (Projection when Persistence is on). */
  listSessionExecutions(sessionId: string): readonly ExecutionInfo[];
  getExecution(
    sessionId: string,
    executionId: string,
  ): ExecutionInfo | undefined;
  submit(
    sessionId: string,
    input: string,
    options?: SessionSubmitOptions,
  ): SessionExecution;
  cancel(sessionId: string, executionId: string): boolean;

  registerWorkspace(
    name: string,
    existingDirectory: string,
  ): Promise<Workspace>;
  createWorkspace(name: string, newDirectory: string): Promise<Workspace>;
  listWorkspaces(): readonly Workspace[];
  getWorkspaceStatus(workspaceId: string): WorkspaceStatus;
  recoverWorkspace(workspaceId: string): Promise<void>;
  removeWorkspace(workspaceId: string): Promise<boolean>;
  getSessionWorkspaceId(sessionId: string): string | undefined;
  getTerminalShell(): string;

  listPendingApprovals(): readonly ApprovalRequest[];
  decideApproval(id: string, decision: ApprovalDecision): ApprovalRequest;
  subscribeApprovals(listener: (request: ApprovalRequest) => void): () => void;
}

export type AgentApplicationErrorCode =
  | 'invalid_input'
  | 'session_not_found'
  | 'operation_failed'
  | 'application_disposed';

const messages: Record<AgentApplicationErrorCode, string> = {
  invalid_input: 'Application input or session options are invalid.',
  session_not_found: 'Session was not found.',
  operation_failed: 'Application operation failed.',
  application_disposed: 'Application is shutting down or has been disposed.',
};

/** Fixed public descriptions never include raw configuration or external errors. */
export class AgentApplicationError extends Error {
  readonly code: AgentApplicationErrorCode;

  constructor(code: AgentApplicationErrorCode) {
    super(messages[code]);
    this.name = 'AgentApplicationError';
    this.code = code;
  }
}
