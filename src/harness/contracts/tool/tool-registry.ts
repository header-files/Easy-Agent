import type { ToolHandler } from './tool-handler.ts';
import type { ToolSpec } from './tool-spec.ts';

export interface RegisteredTool {
  spec: ToolSpec;
  handler: ToolHandler;
}

/** Reusable registry whose exposed declarations cannot mutate internal state. */
export interface ToolRegistry {
  /** Validate the declaration and reject duplicate names instead of replacing them. */
  register(spec: ToolSpec, handler: ToolHandler): void;
  /** Removal does not interrupt a call that already captured this registration. */
  unregister(name: string): boolean;
  get(name: string): RegisteredTool | undefined;
  list(): ToolSpec[];
}
