import type { AgentLoopEvent } from '../agent-loop/index.ts';
import type { ExecutionResult } from './execution-result.ts';

/** In-memory notifications, not persisted facts or a session event log. */
export type ExecutionEvent =
  | {
      type: 'execution_start';
      executionId: string;
      timestamp: string;
    }
  | {
      type: 'loop_event';
      executionId: string;
      event: AgentLoopEvent;
    }
  | {
      type: 'execution_end';
      executionId: string;
      timestamp: string;
      result: ExecutionResult;
    };
