/** A tool declaration; execution is supplied separately by a ToolHandler. */
export interface ToolSpec {
  name: string;
  description: string;
  /** Object-shaped JSON Schema for the handler's arguments. */
  parameters: Record<string, unknown>;
}
