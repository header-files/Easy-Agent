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
import {
  DefaultToolExecutor,
  DefaultToolRegistry,
} from '../runtime/tool/index.ts';
import {
  resolveConfig,
  type EasyAgentConfig,
  type ProviderConfig,
  type ProviderType,
} from './config.ts';
import { registerDemoTool } from './demo-tool.ts';
import { manageLifecycle } from './lifecycle.ts';

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

    let manager = options.manager;
    if (manager === undefined) {
      let loop = options.loop;
      if (loop === undefined) {
        stage = 'tools';
        const registry = new DefaultToolRegistry();
        registerDemoTool(registry);
        for (const { spec, handler } of options.tools ?? []) {
          registry.register(spec, handler);
        }
        const executor = new DefaultToolExecutor(registry, { logger });
        stage = 'loop';
        loop = new DefaultAgentLoop(router, registry, executor);
      }
      stage = 'engine';
      const engine = options.engine ?? new DefaultExecutionEngine({ logger });
      stage = 'agent';
      manager = new DefaultAgentManager(engine, loop, { logger });
    }
    stage = 'application';
    const delegate = new DefaultAgentApplicationService(manager, {
      modelCatalog: modelRegistry,
      defaultSessionOptions: {
        config: {
          model: { name: config.defaultModel },
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
    if (cleanupFailed) {
      Object.defineProperty(error, 'cleanupFailed', {
        value: true,
        enumerable: true,
      });
    }
    throw error;
  }
}
