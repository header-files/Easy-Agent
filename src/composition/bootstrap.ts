import {
  DefaultAgentApplicationService,
  type AgentApplicationService,
} from '../application/index.ts';
import { DefaultAgentManager } from '../agent/index.ts';
import { DefaultExecutionEngine } from '../execution/engine/index.ts';
import { DefaultAgentLoop } from '../execution/loops/index.ts';
import type { AgentManager } from '../harness/contracts/agent/index.ts';
import type { AgentLoop } from '../harness/contracts/agent-loop/index.ts';
import type { ExecutionEngine } from '../harness/contracts/execution/index.ts';
import type { ModelClient } from '../harness/contracts/model/index.ts';
import type { RegisteredTool } from '../harness/contracts/tool/index.ts';
import { createLogger, type Logger } from '../runtime/logging/index.ts';
import {
  DefaultModelRegistry,
  ModelRouter,
  OpenAICompatibleModelClient,
  OpenAIResponsesModelClient,
} from '../runtime/model/index.ts';
import { ApprovalService } from '../runtime/approval/index.ts';
import {
  DefaultToolRegistry,
  GuardedToolExecutor,
  registerBuiltinTools,
  TerminalExecutor,
} from '../runtime/tool/index.ts';
import {
  openPersistenceRuntime,
  PersistenceBridge,
} from '../runtime/persistence/index.ts';
import {
  WorkspaceAccessCoordinator,
  WorkspaceManager,
} from '../runtime/workspace/index.ts';
import {
  resolveConfig,
  type EasyAgentConfig,
  type ProviderConfig,
  type ProviderType,
} from './config.ts';
import { manageLifecycle } from './lifecycle.ts';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type Awaitable<T> = T | Promise<T>;
export interface OwnedModelClient {
  client: ModelClient;
  dispose?: () => Awaitable<void>;
}
export interface ProviderFactoryConfig extends ProviderConfig {
  providerId: string;
}
export type ProviderFactory = (
  config: ProviderFactoryConfig,
  logger: Logger,
) => Awaitable<OwnedModelClient>;

export interface BootstrapOptions {
  loop?: AgentLoop;
  engine?: ExecutionEngine;
  manager?: AgentManager;
  logger?: Logger;
  /** Overrides static built-in factories by provider type; Provider IDs never select implementations. */
  providerFactories?: Partial<Record<ProviderType, ProviderFactory>>;
  /** Additional explicitly registered tools; the default add tool stays available. */
  tools?: readonly RegisteredTool[];
}
export interface EasyAgentApplication {
  readonly service: AgentApplicationService;
  dispose(): Promise<void>;
}
export class BootstrapError extends Error {
  readonly code: 'initialization_failed' | 'cleanup_failed';
  readonly stage: string;
  constructor(code: 'initialization_failed' | 'cleanup_failed', stage: string) {
    super(
      code === 'initialization_failed'
        ? `Application initialization failed (${stage}).`
        : 'Application cleanup failed.',
    );
    this.name = 'BootstrapError';
    this.code = code;
    this.stage = stage;
  }
}

const builtInFactories: Record<ProviderType, ProviderFactory> = {
  'openai-compatible': (config, logger) => ({
    client: new OpenAICompatibleModelClient({
      logger,
      baseURL: config.baseURL,
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    }),
  }),
  'openai-responses': (config, logger) => ({
    client: new OpenAIResponsesModelClient({
      logger,
      baseURL: config.baseURL,
      ...(config.apiKey === undefined ? {} : { apiKey: config.apiKey }),
    }),
  }),
};

function validClient(client: ModelClient): boolean {
  return (
    client !== null &&
    typeof client === 'object' &&
    typeof client.generate === 'function' &&
    typeof client.stream === 'function'
  );
}

/** Static provider factories create immutable startup instances; runtime mutation is unsupported. */
export async function bootstrap(
  input: EasyAgentConfig,
  options: BootstrapOptions = {},
): Promise<EasyAgentApplication> {
  const config = resolveConfig({ fileConfig: input });
  const releases: (() => Awaitable<void>)[] = [];
  let stage = 'options';
  async function releaseAll(): Promise<boolean> {
    let failed = false;
    for (const release of releases.splice(0).reverse()) {
      try {
        await release();
      } catch {
        failed = true;
      }
    }
    return failed;
  }
  try {
    if (
      typeof options !== 'object' ||
      options === null ||
      Array.isArray(options)
    ) {
      throw new Error();
    }
    const customFactories = options.providerFactories ?? {};
    for (const factory of Object.values(customFactories)) {
      if (typeof factory !== 'function') throw new Error();
    }
    stage = 'logging';
    const secrets = Object.values(config.providers)
      .map((provider) => provider.apiKey)
      .filter((value): value is string => Boolean(value));
    const logger =
      options.logger ??
      createLogger({
        module: 'composition.bootstrap',
        level: config.logging.level,
        env: {},
        redactValues: secrets,
      });
    stage = 'providers';
    const clients = new Map<string, ModelClient>();
    for (const [providerId, provider] of Object.entries(config.providers)) {
      const factory =
        customFactories[provider.type] ?? builtInFactories[provider.type];
      const owned = await factory({ providerId, ...provider }, logger);
      if (!owned) throw new Error();
      // Capture dispose before validating the client so invalid returns still roll back.
      const release = owned.dispose;
      if (release !== undefined) {
        if (typeof release !== 'function') throw new Error();
        releases.push(() => release.call(owned));
      }
      if (!validClient(owned.client)) throw new Error();
      clients.set(providerId, owned.client);
    }
    stage = 'model-registry';
    const modelRegistry = new DefaultModelRegistry(clients, config.models);
    const router = new ModelRouter(modelRegistry);

    stage = 'persistence';
    let persistence: PersistenceBridge | undefined;
    if (config.persistence?.dataDir) {
      // Same ~/ expansion as workspace.path — bare "~" must not resolve under cwd.
      const expanded = expandUserPath(config.persistence.dataDir);
      const dataDir = path.isAbsolute(expanded)
        ? expanded
        : path.resolve(process.cwd(), expanded);
      const runtime = await openPersistenceRuntime(dataDir);
      persistence = new PersistenceBridge(runtime);
      releases.push(() => persistence!.dispose());
      // Durable-ize cold-start INTERRUPTED upgrades before any other commits
      // (e.g. default Workspace registration) refresh projections.
      await flushColdStartInterrupts(persistence);
    }

    stage = 'workspace';
    const coordinator = new WorkspaceAccessCoordinator();
    const workspaces = new WorkspaceManager({ coordinator });
    const approval = new ApprovalService();
    let defaultWorkspaceId: string | undefined;

    if (persistence) {
      for (const projection of persistence.projections.workspaces.values()) {
        if (projection.removed || !projection.rootPath) continue;
        workspaces.restore({
          id: projection.workspaceId,
          name: projection.name ?? projection.workspaceId,
          rootPath: projection.rootPath,
        });
        if (projection.safety === 'UNSAFE') {
          coordinator.markUnsafe(projection.workspaceId);
        }
        if (defaultWorkspaceId === undefined) {
          defaultWorkspaceId = projection.workspaceId;
          workspaces.setDefault(projection.workspaceId);
        }
      }
    }

    if (config.workspace?.path) {
      const workspacePath = expandUserPath(config.workspace.path);
      const existing = workspaces
        .list()
        .find((item) => item.rootPath === workspacePath);
      if (existing) {
        defaultWorkspaceId = existing.id;
      } else {
        try {
          await fs.access(workspacePath);
          const registered = await workspaces.register(
            'default',
            workspacePath,
          );
          defaultWorkspaceId = registered.id;
          if (persistence) {
            await persistence.requireWorkspaceRecords([
              {
                type: 'workspace/registered',
                payload: {
                  workspaceId: registered.id,
                  name: registered.name,
                  rootPath: registered.rootPath,
                },
              },
            ]);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          // create() uses non-recursive mkdir; ensure parent exists for ~/… paths.
          await fs.mkdir(path.dirname(workspacePath), { recursive: true });
          const created = await workspaces.create('default', workspacePath);
          defaultWorkspaceId = created.id;
          if (persistence) {
            await persistence.requireWorkspaceRecords([
              {
                type: 'workspace/registered',
                payload: {
                  workspaceId: created.id,
                  name: created.name,
                  rootPath: created.rootPath,
                },
              },
            ]);
          }
        }
      }
    }
    const terminal = new TerminalExecutor(
      config.terminal?.shell === undefined
        ? {}
        : { shell: config.terminal.shell },
    );

    let manager = options.manager;
    if (manager === undefined) {
      let loop = options.loop;
      if (loop === undefined) {
        stage = 'tools';
        const registry = new DefaultToolRegistry();
        registerBuiltinTools(registry, {
          manager: workspaces,
          coordinator,
          terminal,
          ...(persistence === undefined ? {} : { persistence }),
        });
        for (const { spec, handler } of options.tools ?? []) {
          // Explicit bootstrap injections are developer-owned; default never/none
          // so offline tests and custom tools are not stuck without an approval UI.
          // Builtins register their own meta; unknown production tools should set always.
          registry.register(spec, handler, {
            approval: 'never',
            workspaceAccess: 'none',
          });
        }
        const executor = new GuardedToolExecutor(registry, {
          logger,
          approval,
          coordinator,
          ...(config.workspace?.approvalTimeoutMs === undefined
            ? {}
            : { approvalTimeoutMs: config.workspace.approvalTimeoutMs }),
          ...(persistence === undefined ? {} : { persistence }),
        });
        stage = 'loop';
        loop = new DefaultAgentLoop(
          router,
          registry,
          executor,
          persistence === undefined ? {} : { persistence },
        );
      }
      stage = 'engine';
      const engine = options.engine ?? new DefaultExecutionEngine({ logger });
      stage = 'agent';
      manager = new DefaultAgentManager(engine, loop, {
        logger,
        ...(persistence === undefined ? {} : { persistence }),
      });
      if (persistence && manager instanceof DefaultAgentManager) {
        for (const session of persistence.projections.sessions.values()) {
          if (session.removed) continue;
          const messages =
            persistence.projections.messagesBySession.get(session.sessionId) ??
            [];
          const restored = manager.restoreSession({
            projection: session,
            messages,
          });
          if (session.workspaceId) {
            // Projection integrity already checked; bind must succeed for writable mode.
            if (
              !workspaces.bindSession(session.workspaceId, restored.sessionId)
            ) {
              throw new BootstrapError('initialization_failed', 'persistence');
            }
          }
        }
        // Idempotent: early flush already wrote these when open succeeded.
        await flushColdStartInterrupts(persistence);
      }
    }
    stage = 'application';
    const delegate = new DefaultAgentApplicationService(manager, {
      modelCatalog: modelRegistry,
      workspaces,
      coordinator,
      approval,
      terminalShell: terminal.getShell(),
      ...(defaultWorkspaceId === undefined ? {} : { defaultWorkspaceId }),
      ...(persistence === undefined ? {} : { persistence }),
      defaultSessionOptions: {
        config: {
          model: { name: config.defaultModel },
          extensions: {
            defaultAgentLoop: { maxModelRetries: config.agent.maxModelRetries },
          },
        },
        ...(defaultWorkspaceId === undefined
          ? {}
          : { workspaceId: defaultWorkspaceId }),
      },
    });
    const lifecycle = manageLifecycle(delegate);
    let disposing: Promise<void> | undefined;
    return Object.freeze({
      service: lifecycle.service,
      dispose() {
        lifecycle.close();
        disposing ??= Promise.resolve().then(async () => {
          let failed = false;
          try {
            await lifecycle.stop();
          } catch {
            failed = true;
          }
          if (await releaseAll()) failed = true;
          if (failed) throw new BootstrapError('cleanup_failed', 'shutdown');
        });
        return disposing;
      },
    });
  } catch {
    const cleanupFailed = await releaseAll();
    const error = new BootstrapError('initialization_failed', stage);
    if (cleanupFailed) {
      Object.defineProperty(error, 'cleanupFailed', {
        value: true,
        enumerable: true,
      });
    }
    throw error;
  }
}

/** Persist cold-start INTERRUPTED upgrades as interrupted_detected (idempotent). */
async function flushColdStartInterrupts(
  persistence: PersistenceBridge,
): Promise<void> {
  const bySession = new Map<string, string[]>();
  for (const execution of persistence.projections.executions.values()) {
    if (!execution.needsInterruptPersist) continue;
    const list = bySession.get(execution.sessionId) ?? [];
    list.push(execution.executionId);
    bySession.set(execution.sessionId, list);
  }
  for (const [sessionId, ids] of bySession) {
    await persistence.requireSessionEvents(
      sessionId,
      ids.map((executionId) => ({
        type: 'execution/interrupted_detected',
        payload: { executionId },
        executionId,
      })),
    );
  }
}

/** Expand leading `~` / `~/` to the current user home; leave other paths unchanged. */
export function expandUserPath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~' + path.sep)) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}
