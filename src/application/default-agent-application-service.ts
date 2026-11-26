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
import {
  isCommitUncertain,
  isDurableCommittedFailure,
  type ExecutionProjection,
  type PersistenceBridge,
} from '../runtime/persistence/index.ts';
import type {
  Workspace,
  WorkspaceAccessCoordinator,
  WorkspaceManager,
  WorkspaceStatus,
} from '../runtime/workspace/index.ts';
import {
  AgentApplicationError,
  type AgentApplicationService,
  type ExecutionInfo,
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
  persistence?: PersistenceBridge;
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
  private readonly persistence: PersistenceBridge | undefined;

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
    this.persistence = options.persistence;
  }

  async createSession(options?: CreateSessionOptions): Promise<SessionInfo> {
    validateCreate(options);
    const modelId =
      options?.config?.model?.name ?? this.defaults.config?.model?.name;
    if (modelId !== undefined && !this.models.has(modelId)) invalid();
    const workspaceId =
      options?.workspaceId ??
      this.defaults.workspaceId ??
      this.defaultWorkspaceId;
    const assertWorkspaceUsable = (id: string): void => {
      if (!this.workspaces?.get(id)) invalid();
      const projection = this.persistence?.projections.workspaces.get(id);
      if (projection?.removed) invalid();
    };
    if (workspaceId !== undefined) assertWorkspaceUsable(workspaceId);
    const create = async (): Promise<SessionInfo> => {
      // Re-validate under the lifecycle lock: delete may have completed while waiting.
      if (workspaceId !== undefined) assertWorkspaceUsable(workspaceId);
      const session = this.manager.createSession({
        ...this.defaults,
        ...options,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        config: mergeConfig(this.defaults.config, options?.config),
      });
      if (
        this.persistence &&
        'ensureCreated' in session &&
        typeof (session as { ensureCreated?: () => Promise<void> })
          .ensureCreated === 'function'
      ) {
        await (
          session as { ensureCreated: () => Promise<void> }
        ).ensureCreated();
      }
      if (workspaceId !== undefined) {
        // Workspace may have been removed if lock was not held; re-check before bind.
        assertWorkspaceUsable(workspaceId);
        this.workspaces?.bindSession(workspaceId, session.sessionId);
      }
      return Object.freeze({ sessionId: session.sessionId });
    };
    try {
      if (this.persistence && workspaceId !== undefined) {
        return await this.persistence.lifecycle.withShared(workspaceId, create);
      }
      return await create();
    } catch (error) {
      if (error instanceof AgentApplicationError) throw error;
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

  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    if (
      typeof modelId !== 'string' ||
      !modelId.trim() ||
      !this.models.has(modelId)
    )
      invalid();
    const session = this.session(sessionId);
    try {
      await session.setModel(modelId);
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

  listSessionExecutions(sessionId: string): readonly ExecutionInfo[] {
    this.session(sessionId);
    if (!this.persistence) return Object.freeze([]);
    try {
      return Object.freeze(
        [...this.persistence.projections.executions.values()]
          .filter((item) => item.sessionId === sessionId)
          .map((item) => toExecutionInfo(item)),
      );
    } catch {
      throw new AgentApplicationError('operation_failed');
    }
  }

  getExecution(
    sessionId: string,
    executionId: string,
  ): ExecutionInfo | undefined {
    validId(executionId);
    this.session(sessionId);
    if (!this.persistence) return undefined;
    try {
      const execution =
        this.persistence.projections.executions.get(executionId);
      if (!execution || execution.sessionId !== sessionId) return undefined;
      return toExecutionInfo(execution);
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
    let workspace: Workspace | undefined;
    try {
      workspace = await this.workspaces.register(name, existingDirectory);
      await this.persistWorkspaceRegistered(workspace);
      return workspace;
    } catch (error) {
      return this.finishWorkspacePersist(workspace, error);
    }
  }

  async createWorkspace(
    name: string,
    newDirectory: string,
  ): Promise<Workspace> {
    if (!this.workspaces) throw new AgentApplicationError('operation_failed');
    let workspace: Workspace | undefined;
    try {
      workspace = await this.workspaces.create(name, newDirectory);
      await this.persistWorkspaceRegistered(workspace);
      return workspace;
    } catch (error) {
      return this.finishWorkspacePersist(workspace, error);
    }
  }

  private finishWorkspacePersist(
    workspace: Workspace | undefined,
    error: unknown,
  ): Workspace {
    if (workspace && isDurableCommittedFailure(error)) {
      // Registry COMMITTED; keep memory visible to match durable truth.
      return workspace;
    }
    if (workspace && isCommitUncertain(error)) {
      // Ops may already be on disk; do not roll back as "registration absent".
      throw new AgentApplicationError('operation_failed');
    }
    if (workspace) this.rollbackWorkspace(workspace.id);
    throw new AgentApplicationError('operation_failed');
  }

  private rollbackWorkspace(workspaceId: string): void {
    try {
      this.workspaces?.remove(workspaceId);
    } catch {
      /* Best effort: keep fail-closed API result. */
    }
  }

  private async persistWorkspaceRegistered(
    workspace: Workspace,
  ): Promise<void> {
    if (!this.persistence) return;
    await this.persistence.requireWorkspaceRecords([
      {
        type: 'workspace/registered',
        payload: {
          workspaceId: workspace.id,
          name: workspace.name,
          rootPath: workspace.rootPath,
        },
      },
    ]);
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

  async recoverWorkspace(workspaceId: string): Promise<void> {
    validId(workspaceId);
    if (!this.coordinator || !this.workspaces?.get(workspaceId)) {
      throw new AgentApplicationError('operation_failed');
    }
    // Refuse while any Terminal intent is still running in this process.
    if (this.coordinator.listLiveTerminalActivities(workspaceId).length > 0) {
      throw new AgentApplicationError('operation_failed');
    }
    if (this.persistence) {
      try {
        const projection =
          this.persistence.projections.workspaces.get(workspaceId);
        const covered = projection ? [...projection.openIntents] : [];
        await this.persistence.requireWorkspaceRecords([
          {
            type: 'workspace/recovered',
            payload: {
              workspaceId,
              coveredActivityIds: covered,
            },
          },
        ]);
      } catch {
        throw new AgentApplicationError('operation_failed');
      }
    }
    this.coordinator.recover(workspaceId);
  }

  async removeWorkspace(workspaceId: string): Promise<boolean> {
    validId(workspaceId);
    if (!this.workspaces) throw new AgentApplicationError('operation_failed');
    try {
      if (this.persistence) {
        return await this.persistence.lifecycle.withExclusive(
          workspaceId,
          async () => {
            const refs =
              this.persistence!.projections.workspaceSessionRefs.get(
                workspaceId,
              );
            if (refs && refs.size > 0) {
              throw new AgentApplicationError('operation_failed');
            }
            await this.persistence!.requireWorkspaceRecords([
              {
                type: 'workspace/removed',
                payload: { workspaceId },
              },
            ]);
            return this.workspaces!.remove(workspaceId);
          },
        );
      }
      return this.workspaces.remove(workspaceId);
    } catch (error) {
      if (error instanceof AgentApplicationError) throw error;
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

function toExecutionInfo(item: ExecutionProjection): ExecutionInfo {
  return Object.freeze({
    executionId: item.executionId,
    sessionId: item.sessionId,
    status: item.status,
    ...(item.input === undefined ? {} : { input: item.input }),
    ...(item.model === undefined ? {} : { model: item.model }),
    ...(item.interrupted === undefined
      ? {}
      : { interrupted: item.interrupted }),
    ...(item.result === undefined ? {} : { result: item.result }),
    ...(item.error === undefined ? {} : { error: item.error }),
  });
}
