import type { AgentLoop, AgentLoopContext } from '../agent-loop/index.ts';

export interface ExecutionRequest {
  /** Assigned by the caller; duplicate retained ids are rejected before execution starts. */
  executionId: string;
  loop: AgentLoop;
  /** Existing Loop input; metadata.executionId, when present, must match executionId. */
  context: AgentLoopContext;
}
