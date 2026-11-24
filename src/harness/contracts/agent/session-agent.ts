import type { AgentLoopContext } from '../agent-loop/index.ts';
import type { SessionExecution } from './session-execution.ts';
import type { SessionSubmitOptions } from './session-options.ts';

export interface SessionAgent {
  readonly sessionId: string;
  /** Validate and enqueue synchronously; closed/deleted sessions reject and observation never starts work. */
  submit(input: string, options?: SessionSubmitOptions): SessionExecution;
  /** Return a defensive snapshot of the latest successfully committed context. */
  getContext(): AgentLoopContext['context'];
  /** Accept queued/running cancellation in this session; true is not a terminal acknowledgement. */
  cancel(executionId: string): boolean;
}
