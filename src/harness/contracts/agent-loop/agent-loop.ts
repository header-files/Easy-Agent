import type { AgentLoopContext } from './agent-loop-context.ts';
import type { AgentLoopEvent } from './agent-loop-event.ts';

/** Reusable loop implementation; each consumed run owns its mutable state. */
export interface AgentLoop {
  /** Normal completion's sole authoritative result is the final loop_end event. */
  run(context: AgentLoopContext): AsyncIterable<AgentLoopEvent>;
}
