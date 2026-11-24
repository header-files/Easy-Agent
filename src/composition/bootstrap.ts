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
  OpenAICompatibleModelClient,
  type OpenAICompatibleConfig,
} from '../runtime/model/index.ts';
import {
  DefaultToolExecutor,
  DefaultToolRegistry,
} from '../runtime/tool/index.ts';
import { resolveConfig, type EasyAgentConfig } from './config.ts';
import { registerDemoTool } from './demo-tool.ts';
import { manageLifecycle } from './lifecycle.ts';

type Awaitable<T> = T | Promise<T>;
export interface OwnedModelClient {
  client: ModelClient;
  dispose?: () => Awaitable<void>;
}
export interface BootstrapOptions {
  /** Injected shared instances remain owned by the caller. */
  modelClient?: ModelClient;
  loop?: AgentLoop;
  engine?: ExecutionEngine;
  manager?: AgentManager;
  logger?: Logger;
  /** A small owned-resource factory seam; mutually exclusive with modelClient. */
  createModelClient?: (
    config: OpenAICompatibleConfig,
  ) => Awaitable<OwnedModelClient>;
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

/** Assembles existing public components; no scheduling, Loop algorithm or transport policy. */
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
      options.modelClient !== undefined &&
      options.createModelClient !== undefined
    )
      throw new Error();
    stage = 'logging';
    const logger =
      options.logger ??
      createLogger({
        module: 'composition.bootstrap',
        level: config.logging.level,
        env: {},
        redactValues: config.model.apiKey ? [config.model.apiKey] : [],
      });
    let manager = options.manager;
    if (manager === undefined) {
      let loop = options.loop;
      if (loop === undefined) {
        stage = 'model';
        let model = options.modelClient;
        if (model === undefined) {
          const provider: OpenAICompatibleConfig = {
            logger,
            ...(config.model.baseUrl === undefined
              ? {}
              : { baseURL: config.model.baseUrl }),
            ...(config.model.apiKey === undefined
              ? {}
              : { apiKey: config.model.apiKey }),
          };
          if (options.createModelClient === undefined)
            model = new OpenAICompatibleModelClient(provider);
          else {
            const owned = await options.createModelClient(provider);
            const release = owned.dispose;
            if (typeof release === 'function')
              releases.push(() => release.call(owned));
            model = owned.client;
          }
        }
        if (
          !model ||
          typeof model.generate !== 'function' ||
          typeof model.stream !== 'function'
        )
          throw new Error();
        stage = 'tools';
        const registry = new DefaultToolRegistry();
        registerDemoTool(registry);
        for (const { spec, handler } of options.tools ?? [])
          registry.register(spec, handler);
        const executor = new DefaultToolExecutor(registry, { logger });
        stage = 'loop';
        loop = new DefaultAgentLoop(model, registry, executor);
      }
      stage = 'engine';
      const engine = options.engine ?? new DefaultExecutionEngine({ logger });
      stage = 'agent';
      manager = new DefaultAgentManager(engine, loop, { logger });
    }
    stage = 'application';
    const delegate = new DefaultAgentApplicationService(manager, {
      defaultSessionOptions: {
        config: {
          model: {
            name: config.model.name,
            ...(config.model.parameters === undefined
              ? {}
              : { parameters: config.model.parameters }),
          },
          extensions: {
            defaultAgentLoop: { maxModelRetries: config.agent.maxModelRetries },
          },
        },
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
    if (cleanupFailed)
      Object.defineProperty(error, 'cleanupFailed', {
        value: true,
        enumerable: true,
      });
    throw error;
  }
}
