import type { ExecutionEvent } from './execution-event.ts';
import type { ExecutionRequest } from './execution-request.ts';
import type { ExecutionSnapshot } from './execution-snapshot.ts';

export interface ExecutionEngine {
  /** Lazy, single-consumer, single-use stream; start validation occurs on first consumption. */
  execute(request: ExecutionRequest): AsyncIterable<ExecutionEvent>;
  /** Request cancellation of an active id; true does not mean a terminal state is committed. */
  cancel(executionId: string): boolean;
  /** Return a defensive data snapshot without engine-private state; absent/evicted ids return undefined. */
  getSnapshot(executionId: string): ExecutionSnapshot | undefined;
}
