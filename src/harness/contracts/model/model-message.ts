import type { ModelToolCall } from './model-tool.ts';

export interface SystemMessage {
  role: 'system';
  content: string;
}

export interface UserMessage {
  role: 'user';
  content: string;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  toolCalls?: ModelToolCall[];
}

export interface ToolResultMessage {
  role: 'tool';
  toolCallId: string;
  content: string;
  /** A tool execution failure, rather than a failed model request. */
  isError?: boolean;
}

export type ModelMessage =
  SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;
