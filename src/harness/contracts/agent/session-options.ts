import type { AgentLoop, AgentLoopContext } from '../agent-loop/index.ts';
import type { ModelParameters } from '../model/index.ts';

export interface CreateSessionOptions {
  /** Defaults to the AgentManager's injected reusable Loop. */
  loop?: AgentLoop;
  /** Initial committed context; defaults to { messages: [] }. */
  context?: AgentLoopContext['context'];
  config?: AgentLoopContext['config'];
  /** Bound at creation; sessions do not switch workspace afterward. */
  workspaceId?: string;
}

/** Partial per-submission override; Loop selection remains fixed for the session. */
export interface SessionSubmitOptions {
  config?: {
    model?: {
      name?: string;
      parameters?: ModelParameters;
    };
    tools?: {
      allowedNames?: readonly string[];
    };
    extensions?: Readonly<Record<string, unknown>>;
  };
}
