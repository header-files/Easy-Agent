import type { AgentLoopResult } from '../agent-loop/index.ts';

export type ExecutionErrorCode =
  'loop_stopped' | 'loop_protocol_error' | 'loop_error' | 'internal_error';

export interface ExecutionErrorInfo {
  code: ExecutionErrorCode;
  /** Stable, safe public description; never a raw external error or response body. */
  message: string;
}

/** Final state only; a cancellation request is not itself an ExecutionResult. */
export type ExecutionResult =
  | {
      status: 'COMPLETED';
      loopResult: AgentLoopResult;
    }
  | {
      status: 'FAILED';
      error: ExecutionErrorInfo;
      loopResult?: AgentLoopResult;
    }
  | {
      status: 'CANCELLED';
      reason?: string;
    };
