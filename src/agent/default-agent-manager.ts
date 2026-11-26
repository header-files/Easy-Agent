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
import type {
  MessageProjectionItem,
  PersistenceBridge,
  SessionProjection,
} from '../runtime/persistence/index.ts';
import {
  isCommitUncertain,
  isDurableCommittedFailure,
} from '../runtime/persistence/index.ts';
import { DefaultSessionAgent } from './default-session-agent.ts';
import { validId } from './session-config.ts';

export interface DefaultAgentManagerOptions {
  eventBufferCapacity?: number;
  sessionIdFactory?: () => string;
  executionIdFactory?: () => string;
  logger?: Logger;
  persistence?: PersistenceBridge;
}

export interface RestoreSessionInput {
  projection: SessionProjection;
  messages: readonly MessageProjectionItem[];
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
  private readonly persistence: PersistenceBridge | undefined;

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
    this.persistence = options.persistence;
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

  private buildSession(
    id: string,
    options: CreateSessionOptions,
    restored: boolean,
  ): DefaultSessionAgent {
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
    const session = new DefaultSessionAgent(id, this.engine, loop, {
      context: context === undefined ? { messages: [] } : context,
      config: config === undefined ? {} : config,
      eventBufferCapacity: this.capacity,
      executionId: () =>
        this.nextId(this.executionIdFactory, this.executionIds),
      ...(this.logger === undefined ? {} : { logger: this.logger }),
      ...(workspaceId === undefined ? {} : { workspaceId }),
      ...(this.persistence === undefined
        ? {}
        : { persistence: this.persistence }),
      ...(restored ? { restored: true } : {}),
    });
    this.sessions.set(id, session);
    return session;
  }

  createSession(options: CreateSessionOptions = {}): SessionAgent {
    if (
      typeof options !== 'object' ||
      options === null ||
      Array.isArray(options)
    )
      throw new Error('Invalid session options.');
    const id = this.nextId(this.sessionIdFactory, this.sessionIds);
    return this.buildSession(id, options, false);
  }

  /**
   * Rebuild a live Session from committed projections after cold start.
   * Does not re-emit session/created; unfinished executions stay interrupted.
   */
  restoreSession(input: RestoreSessionInput): SessionAgent {
    const { projection, messages } = input;
    if (
      !validId(projection.sessionId) ||
      this.sessionIds.has(projection.sessionId) ||
      projection.removed
    ) {
      throw new Error('Invalid or duplicate restored session id.');
    }
    this.sessionIds.add(projection.sessionId);
    const initialRaw = (projection.initialContext?.messages ??
      []) as readonly MessageLike[];
    const executionMessages = mapRestoredMessages(messages);
    // Authoritative Message Projection already includes the full committed context.
    const contextMessages = projection.messagesAuthoritative
      ? executionMessages
      : [...mapRestoredMessages(initialRaw), ...executionMessages];
    const contextData = projection.messagesAuthoritative
      ? projection.committedContextData
      : projection.initialContext?.data;
    const restoredContext = {
      messages: contextMessages,
      ...(contextData === undefined
        ? {}
        : { data: structuredClone(contextData) }),
    };
    const session = this.buildSession(
      projection.sessionId,
      {
        context: restoredContext,
        config: {
          ...(projection.model === undefined
            ? {}
            : {
                model: {
                  name: projection.model,
                  ...(projection.modelParameters === undefined
                    ? {}
                    : { parameters: projection.modelParameters }),
                },
              }),
          ...(projection.allowedNames === undefined
            ? {}
            : { tools: { allowedNames: projection.allowedNames } }),
          ...(projection.extensions === undefined
            ? {}
            : { extensions: projection.extensions }),
        },
        ...(projection.workspaceId === undefined
          ? {}
          : { workspaceId: projection.workspaceId }),
      },
      true,
    );
    // Keep messages + data together; messages-only would drop context.data.
    session.replaceCommittedContext(restoredContext);
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
    if (this.persistence) {
      try {
        await this.persistence.requireSessionEvents(sessionId, [
          { type: 'session/deleted', payload: {} },
        ]);
      } catch (error) {
        if (isDurableCommittedFailure(error)) {
          // Durable delete committed; drop memory even if projection refresh failed.
        } else if (isCommitUncertain(error)) {
          // May already be durable after roll-forward — do not revive as "not deleted".
          throw error;
        } else {
          session.reviveAfterFailedDelete();
          return false;
        }
      }
    }
    this.sessions.delete(sessionId);
    return true;
  }
}

type MessageLike = {
  role?: unknown;
  content?: unknown;
  toolCallId?: unknown;
  toolCalls?: unknown;
  isError?: unknown;
};

function mapRestoredMessages(messages: readonly MessageLike[]) {
  return messages.map((message) => {
    if (message.role === 'user') {
      return {
        role: 'user' as const,
        content: typeof message.content === 'string' ? message.content : '',
      };
    }
    if (message.role === 'assistant') {
      return {
        role: 'assistant' as const,
        content:
          message.content === undefined
            ? null
            : (message.content as string | null),
        ...(message.toolCalls === undefined
          ? {}
          : { toolCalls: message.toolCalls as never }),
      };
    }
    return {
      role: 'tool' as const,
      content: typeof message.content === 'string' ? message.content : '',
      toolCallId:
        typeof message.toolCallId === 'string' ? message.toolCallId : '',
      ...(message.isError === undefined
        ? {}
        : { isError: Boolean(message.isError) }),
    };
  });
}
