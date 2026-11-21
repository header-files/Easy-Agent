import type { ModelMessage } from './model-message.ts';
import type { ModelToolChoice, ModelToolDefinition } from './model-tool.ts';

export interface ModelParameters {
  temperature?: number;
  maxOutputTokens?: number;
  /** Provider-native generation parameters, subject to adapter conflict checks. */
  [key: string]: unknown;
}

export interface ModelRequest {
  model: string;
  /** The caller owns conversation history; adapters do not mutate these messages. */
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  toolChoice?: ModelToolChoice;
  parameters?: ModelParameters;
}
