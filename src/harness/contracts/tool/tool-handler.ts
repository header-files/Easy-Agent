export interface ToolExecutionContext {
  toolCallId: string;
  /** Cooperative cancellation; it does not imply side effects were rolled back. */
  signal: AbortSignal;
}

export interface ToolHandlerOutput {
  content: string;
}

/** Receives parsed, schema-validated object arguments from the ToolExecutor. */
export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolExecutionContext,
) => ToolHandlerOutput | Promise<ToolHandlerOutput>;
