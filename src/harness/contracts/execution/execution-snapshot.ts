import type { ExecutionResult } from './execution-result.ts';

export type ExecutionStatus = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

/** Data view without engine-private control state; terminal snapshots include endedAt/result. */
export interface ExecutionSnapshot {
  executionId: string;
  status: ExecutionStatus;
  /** ISO 8601 UTC wall-clock time. */
  startedAt: string;
  endedAt?: string;
  /** Elapsed duration from a monotonic source, independent of wall-clock adjustments. */
  durationMs?: number;
  result?: ExecutionResult;
}
