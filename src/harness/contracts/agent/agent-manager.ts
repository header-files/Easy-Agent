import type { SessionAgent } from './session-agent.ts';
import type { CreateSessionOptions } from './session-options.ts';
import type { SessionSummary } from './session-summary.ts';

export interface AgentManager {
  /** Synchronously register an in-memory session and return its stable live instance. */
  createSession(options?: CreateSessionOptions): SessionAgent;
  getSession(sessionId: string): SessionAgent | undefined;
  /** Return creation-ordered summary snapshots, not internal queue or Map references. */
  listSessions(): SessionSummary[];
  /** Delete only idle sessions, closing held session references against further submissions. */
  deleteSession(sessionId: string): Promise<boolean>;
}
