import type { ModelMessage, ModelParameters } from '../model/index.ts';

/** Algorithm-neutral input; model and tools are optional for custom loops. */
export interface AgentLoopContext {
  input: {
    content: string;
  };
  context: {
    messages: readonly ModelMessage[];
    data?: Readonly<Record<string, unknown>>;
  };
  config: {
    model?: {
      name: string;
      parameters?: ModelParameters;
    };
    tools?: {
      allowedNames?: readonly string[];
    };
    extensions?: Readonly<Record<string, unknown>>;
  };
  control: {
    signal: AbortSignal;
  };
  metadata?: {
    sessionId?: string;
    executionId?: string;
    workspaceId?: string;
  };
}
