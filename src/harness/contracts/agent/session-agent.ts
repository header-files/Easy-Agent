import type { AgentLoopContext } from '../agent-loop/index.ts';
import type { SessionExecution } from './session-execution.ts';
import type { SessionSubmitOptions } from './session-options.ts';

export interface SessionAgent {
  readonly sessionId: string;
  /** Validate and enqueue synchronously; closed/deleted sessions reject and observation never starts work. */
  submit(input: string, options?: SessionSubmitOptions): SessionExecution;
  /** Return a defensive snapshot of the latest successfully committed context. */
  getContext(): AgentLoopContext['context'];
  /** Current default model for future submissions; queued work is already fixed. */
  getModel(): string | undefined;
  /** Replace the default model for future submissions only. */
  setModel(modelId: string): void;
  /** Workspace bound at session creation, if any. */
  getWorkspaceId?(): string | undefined;
  /** Accept queued/running cancellation in this session; true is not a terminal acknowledgement. */
  cancel(executionId: string): boolean;
}
