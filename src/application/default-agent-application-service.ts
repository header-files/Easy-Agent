import type {
  AgentManager,
  CreateSessionOptions,
  SessionAgent,
  SessionExecution,
  SessionSubmitOptions,
  SessionSummary,
} from '../harness/contracts/agent/index.ts';
import type { AgentLoopContext } from '../harness/contracts/agent-loop/index.ts';
import type {
  ModelCatalog,
  ModelDescriptor,
} from '../harness/contracts/model/index.ts';
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalService,
} from '../runtime/approval/index.ts';
import type {
  Workspace,
  WorkspaceAccessCoordinator,
  WorkspaceManager,
  WorkspaceStatus,
} from '../runtime/workspace/index.ts';
import {
  AgentApplicationError,
  type AgentApplicationService,
  type SessionInfo,
} from './agent-application-service.ts';

export interface DefaultAgentApplicationServiceOptions {
  modelCatalog: ModelCatalog;
  /** Bootstrap-owned defaults; do not mutate them during the service lifetime. */
  defaultSessionOptions?: CreateSessionOptions;
  workspaces?: WorkspaceManager;
  coordinator?: WorkspaceAccessCoordinator;
  approval?: ApprovalService;
  terminalShell?: string;
  defaultWorkspaceId?: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(): never {
  throw new AgentApplicationError('invalid_input');
}

function validId(value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) invalid();
}

function validateConfig(value: unknown, partial: boolean): void {
  if (value === undefined) return;
  if (!record(value)) invalid();
  const { model, tools, extensions } = value;
  if (model !== undefined) {
    if (!record(model)) invalid();
    if (
      (!partial && typeof model.name !== 'string') ||
      (model.name !== undefined && typeof model.name !== 'string') ||
      (model.parameters !== undefined && !record(model.parameters))
    )
      invalid();
  }
  if (tools !== undefined) {
    if (!record(tools)) invalid();
    if (
      tools.allowedNames !== undefined &&
      (!Array.isArray(tools.allowedNames) ||
        !tools.allowedNames.every((name: unknown) => typeof name === 'string'))
    )
      invalid();
  }
  if (extensions !== undefined && !record(extensions)) invalid();
}

function validateCreate(value: CreateSessionOptions | undefined): void {
  try {
    if (value === undefined) return;
    if (!record(value)) invalid();
    if (
      value.loop !== undefined &&
      ((typeof value.loop !== 'object' && typeof value.loop !== 'function') ||
        value.loop === null ||
        !('run' in value.loop) ||
        typeof value.loop.run !== 'function')
    )
      invalid();
    if (
      value.context !== undefined &&
      (!record(value.context) || !Array.isArray(value.context.messages))
    )
      invalid();
    validateConfig(value.config, false);
  } catch {
    invalid();
  }
}

/** Namespace values are whole overrides; unknown parameter/accessor values stay opaque. */
function mergeFields(
  defaults: Readonly<Record<string, unknown>> = {},
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(defaults),
      ...Object.getOwnPropertyDescriptors(overrides),
    },
  );
}

function mergeConfig(
  defaults: AgentLoopContext['config'] | undefined,
  overrides: AgentLoopContext['config'] | undefined,
): AgentLoopContext['config'] {
  const model = overrides?.model ?? defaults?.model;
  const baseParameters = defaults?.model?.parameters;
  const parameters = overrides?.model?.parameters;
  const tools =
    overrides?.tools?.allowedNames === undefined
      ? defaults?.tools
      : overrides.tools;
  return {
    ...(model === undefined
      ? {}
      : {
          model: {
            name: model.name,
            ...(baseParameters === undefined && parameters === undefined
              ? {}
              : { parameters: mergeFields(baseParameters, parameters) }),
          },
        }),
    ...(tools === undefined ? {} : { tools }),
    ...(defaults?.extensions === undefined &&
    overrides?.extensions === undefined
      ? {}
      : {
          extensions: mergeFields(defaults?.extensions, overrides?.extensions),
        }),
  };
}

/** Thin delegation only: it owns no sessions, execution state, history or queue. */
export class DefaultAgentApplicationService implements AgentApplicationService {
  private readonly manager: AgentManager;
  private readonly models: ModelCatalog;
  private readonly defaults: CreateSessionOptions;
  private readonly workspaces: WorkspaceManager | undefined;
  private readonly coordinator: WorkspaceAccessCoordinator | undefined;
  private readonly approval: ApprovalService | undefined;
  private readonly terminalShell: string;
  private readonly defaultWorkspaceId: string | undefined;

  constructor(
    manager: AgentManager,
    options: DefaultAgentApplicationServiceOptions,
  ) {
    if (
      typeof options !== 'object' ||
      options === null ||
      Array.isArray(options)
    )
      invalid();
    validateCreate(options.defaultSessionOptions);
    if (
      !record(options.modelCatalog) ||
      typeof options.modelCatalog.has !== 'function' ||
      typeof options.modelCatalog.list !== 'function'
    )
      invalid();
    const defaultModel = options.defaultSessionOptions?.config?.model?.name;
    if (defaultModel !== undefined && !options.modelCatalog.has(defaultModel))
      invalid();
    this.manager = manager;
    this.models = options.modelCatalog;
    this.defaults = options.defaultSessionOptions ?? {};
    this.workspaces = options.workspaces;
    this.coordinator = options.coordinator;
    this.approval = options.approval;
    this.terminalShell = options.terminalShell ?? '';
    this.defaultWorkspaceId = options.defaultWorkspaceId;
  }

  createSession(options?: CreateSessionOptions): SessionInfo {
    validateCreate(options);
    const modelId =
      options?.config?.model?.name ?? this.defaults.config?.model?.name;
    if (modelId !== undefined && !this.models.has(modelId)) invalid();
    const workspaceId =
      options?.workspaceId ??
      this.defaults.workspaceId ??
      this.defaultWorkspaceId;
    if (workspaceId !== undefined) {
      if (!this.workspaces?.get(workspaceId)) invalid();
    }
    try {
      const session = this.manager.createSession({
        ...this.defaults,
        ...options,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        config: mergeConfig(this.defaults.config, options?.config),
      });
      if (workspaceId !== undefined) {
        this.workspaces?.bindSession(workspaceId, session.sessionId);
      }
      return Object.freeze({ sessionId: session.sessionId });
    } catch {
      throw new AgentApplicationError('operation_failed');
    }
  }

  listModels(): readonly ModelDescriptor[] {
    try {
      return this.models.list();
    } catch {
      throw new AgentApplicationError('operation_failed');
    }
  }

  getSessionModel(sessionId: string): string {
    try {
      const model = this.session(sessionId).getModel();
      if (model === undefined) throw new Error();
      return model;
    } catch (error) {
      if (error instanceof AgentApplicationError) throw error;
      throw new AgentApplicationError('operation_failed');
    }
  }

  setSessionModel(sessionId: string, modelId: string): void {
    if (
      typeof modelId !== 'string' ||
      !modelId.trim() ||
      !this.models.has(modelId)
    )
      invalid();
    const session = this.session(sessionId);
    try {
      session.setModel(modelId);
    } catch {
      throw new AgentApplicationError('operation_failed');
    }
  }

  listSessions(): SessionSummary[] {
    try {
      return this.manager.listSessions();
    } catch {
      throw new AgentApplicationError('operation_failed');
    }
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const session = this.session(sessionId);
    const workspaceId = session.getWorkspaceId?.();
    try {
      const removed = await this.manager.deleteSession(sessionId);
      if (removed && workspaceId !== undefined) {
        this.workspaces?.unbindSession(workspaceId, sessionId);
      }
      return removed;
    } catch {
      throw new AgentApplicationError('operation_failed');
    }
  }

  submit(
    sessionId: string,
    input: string,
    options?: SessionSubmitOptions,
  ): SessionExecution {
    if (typeof input !== 'string' || input.trim().length === 0) invalid();
    const modelId = options?.config?.model?.name;
    try {
      if (options !== undefined && !record(options)) invalid();
      validateConfig(options?.config, true);
    } catch {
      invalid();
    }
    if (modelId !== undefined && !this.models.has(modelId)) invalid();
    const session = this.session(sessionId);
    try {
      return session.submit(input, options);
    } catch {
      throw new AgentApplicationError('operation_failed');
    }
  }

  cancel(sessionId: string, executionId: string): boolean {
    validId(executionId);
    const session = this.session(sessionId);
    try {
      return session.cancel(executionId);
    } catch {
      throw new AgentApplicationError('operation_failed');
    }
  }

  async registerWorkspace(
    name: string,
    existingDirectory: string,
  ): Promise<Workspace> {
    if (!this.workspaces) throw new AgentApplicationError('operation_failed');
    try {
      return await this.workspaces.register(name, existingDirectory);
    } catch {
      throw new AgentApplicationError('operation_failed');
    }
  }

  async createWorkspace(
    name: string,
    newDirectory: string,
  ): Promise<Workspace> {
    if (!this.workspaces) throw new AgentApplicationError('operation_failed');
    try {
      return await this.workspaces.create(name, newDirectory);
    } catch {
      throw new AgentApplicationError('operation_failed');
    }
  }

  listWorkspaces(): readonly Workspace[] {
    if (!this.workspaces) throw new AgentApplicationError('operation_failed');
    try {
      return this.workspaces.list();
    } catch {
      throw new AgentApplicationError('operation_failed');
    }
  }

  getWorkspaceStatus(workspaceId: string): WorkspaceStatus {
    validId(workspaceId);
    if (!this.workspaces) throw new AgentApplicationError('operation_failed');
    try {
      return this.workspaces.status(workspaceId);
    } catch {
      throw new AgentApplicationError('operation_failed');
    }
  }

  recoverWorkspace(workspaceId: string): void {
    validId(workspaceId);
    if (!this.coordinator || !this.workspaces?.get(workspaceId)) {
      throw new AgentApplicationError('operation_failed');
    }
    this.coordinator.recover(workspaceId);
  }

  removeWorkspace(workspaceId: string): boolean {
    validId(workspaceId);
    if (!this.workspaces) throw new AgentApplicationError('operation_failed');
    try {
      return this.workspaces.remove(workspaceId);
    } catch {
      throw new AgentApplicationError('operation_failed');
    }
  }

  getSessionWorkspaceId(sessionId: string): string | undefined {
    return this.session(sessionId).getWorkspaceId?.();
  }

  getTerminalShell(): string {
    return this.terminalShell;
  }

  listPendingApprovals(): readonly ApprovalRequest[] {
    if (!this.approval) throw new AgentApplicationError('operation_failed');
    return this.approval.listPending();
  }

  decideApproval(id: string, decision: ApprovalDecision): ApprovalRequest {
    validId(id);
    if (!this.approval) throw new AgentApplicationError('operation_failed');
    try {
      return this.approval.decide(id, decision);
    } catch {
      throw new AgentApplicationError('operation_failed');
    }
  }

  subscribeApprovals(listener: (request: ApprovalRequest) => void): () => void {
    if (!this.approval) throw new AgentApplicationError('operation_failed');
    return this.approval.subscribe(listener);
  }

  private session(sessionId: string): SessionAgent {
    validId(sessionId);
    let session: SessionAgent | undefined;
    try {
      session = this.manager.getSession(sessionId);
    } catch {
      throw new AgentApplicationError('operation_failed');
    }
    if (!session) throw new AgentApplicationError('session_not_found');
    return session;
  }
}
