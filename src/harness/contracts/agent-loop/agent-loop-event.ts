import type { ModelStreamEvent } from '../model/index.ts';
import type { ToolCall, ToolResult } from '../tool/index.ts';
import type { AgentLoopResult } from './agent-loop-result.ts';

export type AgentLoopEvent =
  | { type: 'loop_start' }
  | { type: 'output_delta'; content: string }
  | {
      type: 'model_event';
      /** Starts at 1 within this run; retries retain the logical call's index. */
      modelCallIndex: number;
      event: ModelStreamEvent;
    }
  | {
      type: 'tool_start';
      modelCallIndex: number;
      call: ToolCall;
    }
  | {
      type: 'tool_result';
      modelCallIndex: number;
      result: ToolResult;
    }
  | { type: 'custom_event'; name: string; data: unknown }
  | { type: 'loop_end'; result: AgentLoopResult };
