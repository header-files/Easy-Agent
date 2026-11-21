import type { AssistantMessage } from './model-message.ts';

export type ModelFinishReason =
  'stop' | 'tool_calls' | 'length' | 'content_filter' | 'other';

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ModelResponse {
  id?: string;
  /** Provider-reported model, or the requested identifier when it is absent. */
  model: string;
  message: AssistantMessage;
  finishReason: ModelFinishReason;
  usage?: ModelUsage;
}
