import type {
  ModelToolDefinition,
  ToolResultMessage,
} from '../../harness/contracts/model/index.ts';
import type {
  ToolResult,
  ToolSpec,
} from '../../harness/contracts/tool/index.ts';
import { copyToolSpec } from './tool-validator.ts';

export function toModelToolDefinition(spec: ToolSpec): ModelToolDefinition {
  return copyToolSpec(spec);
}

export function toToolResultMessage(result: ToolResult): ToolResultMessage {
  return {
    role: 'tool',
    toolCallId: result.toolCallId,
    content: result.content,
    isError: result.status === 'error',
  };
}
