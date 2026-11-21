/** Tool declarations describe a capability; they never execute it. */
export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** Preserve model-generated arguments verbatim, even when they are invalid JSON. */
export interface ModelToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export type ModelToolChoice = 'auto' | 'none' | 'required';
