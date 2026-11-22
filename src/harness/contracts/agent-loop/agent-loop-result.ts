import type { AgentLoopContext } from './agent-loop-context.ts';

/** Normal termination only; errors and cancellation propagate through iteration. */
export type AgentLoopResult =
  | {
      status: 'completed';
      output: string;
      /** A complete updated snapshot, never a message delta. */
      updatedContext?: AgentLoopContext['context'];
      details?: Readonly<Record<string, unknown>>;
    }
  | {
      status: 'stopped';
      reason: string;
      output?: string;
      updatedContext?: AgentLoopContext['context'];
      details?: Readonly<Record<string, unknown>>;
    };
