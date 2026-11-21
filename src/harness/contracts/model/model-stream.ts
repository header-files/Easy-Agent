import type { ModelResponse } from './model-response.ts';

/** Failures propagate as ModelError; they never produce a successful message_end. */
export type ModelStreamEvent =
  | { type: 'message_start'; id?: string; model: string }
  | { type: 'text_delta'; text: string }
  | {
      type: 'tool_call_delta';
      index: number;
      id?: string;
      name?: string;
      argumentsDelta?: string;
    }
  | { type: 'message_end'; response: ModelResponse };
