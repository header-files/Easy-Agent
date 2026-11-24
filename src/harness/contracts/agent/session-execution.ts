import type { ExecutionEvent, ExecutionResult } from '../execution/index.ts';

export interface SessionExecution {
  readonly executionId: string;
  /** Independent single-consumer, single-use observation; closing it does not cancel execution. */
  readonly events: AsyncIterable<ExecutionEvent>;
  /** Always resolves to a terminal result, even without an event consumer or on execution failure. */
  readonly result: Promise<ExecutionResult>;
}
