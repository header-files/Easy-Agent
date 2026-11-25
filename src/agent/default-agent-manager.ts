import { randomUUID } from 'node:crypto';
import type {
  AgentManager,
  CreateSessionOptions,
  SessionAgent,
  SessionSummary,
} from '../harness/contracts/agent/index.ts';
import type { AgentLoop } from '../harness/contracts/agent-loop/index.ts';
import type { ExecutionEngine } from '../harness/contracts/execution/index.ts';
import { createLogger, type Logger } from '../runtime/logging/index.ts';
import { DefaultSessionAgent } from './default-session-agent.ts';
import { validId } from './session-config.ts';

export interface DefaultAgentManagerOptions {
  eventBufferCapacity?: number;
  sessionIdFactory?: () => string;
  executionIdFactory?: () => string;
  logger?: Logger;
}

export class DefaultAgentManager implements AgentManager {
  private readonly engine: ExecutionEngine;
  private readonly defaultLoop: AgentLoop;
  private readonly sessions = new Map<string, DefaultSessionAgent>();
  private readonly sessionIds = new Set<string>();
  private readonly executionIds = new Set<string>();
  private readonly capacity: number;
  private readonly sessionIdFactory: () => string;
  private readonly executionIdFactory: () => string;
  private readonly logger: Logger | undefined;

  constructor(
    engine: ExecutionEngine,
    defaultLoop: AgentLoop,
    options: DefaultAgentManagerOptions = {},
  ) {
    if (
      typeof options !== 'object' ||
      options === null ||
      Array.isArray(options)
    )
      throw new Error('Invalid Agent Manager configuration.');
    const capacity =
      options.eventBufferCapacity === undefined
        ? 512
        : options.eventBufferCapacity;
    if (
      !Number.isSafeInteger(capacity) ||
      capacity < 1 ||
      (options.sessionIdFactory !== undefined &&
        typeof options.sessionIdFactory !== 'function') ||
      (options.executionIdFactory !== undefined &&
        typeof options.executionIdFactory !== 'function')
    )
      throw new Error('Invalid Agent Manager configuration.');
    this.engine = engine;
    this.defaultLoop = defaultLoop;
    this.capacity = capacity;
    this.sessionIdFactory = options.sessionIdFactory ?? randomUUID;
    this.executionIdFactory = options.executionIdFactory ?? randomUUID;
    try {
      this.logger =
        options.logger === undefined
          ? createLogger({ module: 'agent.session' })
          : options.logger.child('agent.session');
    } catch {
      this.logger = undefined;
    }
  }
  private nextId(factory: () => string, issued: Set<string>): string {
    try {
      const id: unknown = factory();
      if (!validId(id) || issued.has(id)) throw new Error();
      issued.add(id);
      return id;
    } catch {
      throw new Error('Agent ID generation failed or returned a duplicate.');
    }
  }
  createSession(options: CreateSessionOptions = {}): SessionAgent {
    if (
      typeof options !== 'object' ||
      options === null ||
      Array.isArray(options)
    )
      throw new Error('Invalid session options.');
    const { loop: suppliedLoop, context, config, workspaceId } = options;
    const loop = suppliedLoop === undefined ? this.defaultLoop : suppliedLoop;
    if (
      (typeof loop !== 'object' && typeof loop !== 'function') ||
      loop === null ||
      typeof loop.run !== 'function'
    )
      throw new Error('Invalid session loop.');
    if (workspaceId !== undefined && typeof workspaceId !== 'string') {
      throw new Error('Invalid workspace id.');
    }
    const id = this.nextId(this.sessionIdFactory, this.sessionIds);
    const session = new DefaultSessionAgent(id, this.engine, loop, {
      context: context === undefined ? { messages: [] } : context,
      config: config === undefined ? {} : config,
      eventBufferCapacity: this.capacity,
      executionId: () =>
        this.nextId(this.executionIdFactory, this.executionIds),
      ...(this.logger === undefined ? {} : { logger: this.logger }),
      ...(workspaceId === undefined ? {} : { workspaceId }),
    });
    this.sessions.set(id, session);
    return session;
  }
  getSession(sessionId: string): SessionAgent | undefined {
    return this.sessions.get(sessionId);
  }
  listSessions(): SessionSummary[] {
    return [...this.sessions.values()].map((session) => session.summary());
  }
  async deleteSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.closeIfIdle()) return false;
    this.sessions.delete(sessionId);
    return true;
  }
}
