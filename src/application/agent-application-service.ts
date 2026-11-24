import type {
  CreateSessionOptions,
  SessionExecution,
  SessionSubmitOptions,
  SessionSummary,
} from '../harness/contracts/agent/index.ts';

export interface SessionInfo {
  readonly sessionId: string;
}

/** Transport-neutral application entry; queue, context and execution stay in Agent. */
export interface AgentApplicationService {
  createSession(options?: CreateSessionOptions): SessionInfo;
  listSessions(): SessionSummary[];
  deleteSession(sessionId: string): Promise<boolean>;
  submit(
    sessionId: string,
    input: string,
    options?: SessionSubmitOptions,
  ): SessionExecution;
  cancel(sessionId: string, executionId: string): boolean;
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
