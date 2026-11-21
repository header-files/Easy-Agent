export type ToolErrorCode =
  'tool_not_found' | 'invalid_arguments' | 'execution_failed';

export interface ToolErrorInfo {
  code: ToolErrorCode;
  message: string;
}

export type ToolResult =
  | {
      toolCallId: string;
      name: string;
      status: 'success';
      content: string;
    }
  | {
      toolCallId: string;
      name: string;
      status: 'error';
      content: string;
      error: ToolErrorInfo;
    };
