import type { ToolResult } from './tool-result.ts';

/** Structurally compatible with the existing ModelToolCall contract. */
export interface ToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface ToolExecutionOptions {
  signal?: AbortSignal;
  /** Applies only to the tool handler / terminal run phase, not approval waits. */
  timeoutMs?: number;
  /** Independent approval wait limit for gated executors. */
  approvalTimeoutMs?: number;
  workspaceId?: string;
  sessionId?: string;
  executionId?: string;
}

/** Reusable, concurrent component; each invocation owns its execution state. */
export interface ToolExecutor {
  /** Business failures return ToolResult; cancellation/timeout throw ToolExecutionError. */
  execute(call: ToolCall, options?: ToolExecutionOptions): Promise<ToolResult>;
}
