import type { LogLevel } from '../runtime/logging/index.ts';
import { parseModelId } from '../runtime/model/index.ts';

/** Protocol implementation id — never a vendor name. */
export type ProviderType = 'openai-compatible' | 'openai-responses';

export interface ProviderConfig {
  type: ProviderType;
  baseURL: string;
  apiKey?: string;
}

const PROVIDER_TYPES = new Set<ProviderType>([
  'openai-compatible',
  'openai-responses',
]);

const API_KEY_REQUIRED = new Set<ProviderType>(['openai-responses']);

export interface EasyAgentConfig {
  providers: Readonly<Record<string, ProviderConfig>>;
  models: readonly string[];
  defaultModel: string;
  agent: { maxModelRetries: number };
  cli: { stream: boolean };
  logging: { level: LogLevel };
}

export interface EasyAgentConfigInput {
  providers?: Readonly<Record<string, unknown>>;
  models?: readonly string[];
  defaultModel?: string;
  agent?: Partial<EasyAgentConfig['agent']>;
  cli?: Partial<EasyAgentConfig['cli']>;
  logging?: Partial<EasyAgentConfig['logging']>;
}

export class ConfigurationError extends Error {
  readonly code = 'invalid_configuration';
  constructor(message = 'Application configuration is invalid.') {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function invalid(field: string): never {
  throw new ConfigurationError(`Invalid configuration: ${field}.`);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function section(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === undefined) return {};
  if (!record(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    invalid('supported fields');
  }
  return value;
}

function envInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value.trim())) invalid('agent.maxModelRetries');
  return Number(value);
}

function envBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  switch (value.trim().toLowerCase()) {
    case 'true':
    case '1':
      return true;
    case 'false':
    case '0':
      return false;
    default:
      return invalid('cli.stream');
  }
}

function resolvedText(
  value: unknown,
  field: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') invalid(field);
  const reference = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  if (!reference) return value;
  const resolved = env[reference[1]!];
  if (resolved === undefined) invalid(field);
  return resolved;
}

function validURL(value: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid(field);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    invalid(field);
  }
}

function providers(
  value: unknown,
  env: Readonly<Record<string, string | undefined>>,
): Record<string, ProviderConfig> {
  if (!record(value) || Object.keys(value).length === 0) {
    invalid('providers (required)');
  }
  const result: Record<string, ProviderConfig> = {};
  for (const [providerId, source] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(providerId)) {
      invalid('providers provider ID');
    }
    const provider = section(source, ['type', 'baseURL', 'apiKey']);
    if (
      typeof provider.type !== 'string' ||
      !PROVIDER_TYPES.has(provider.type as ProviderType)
    ) {
      invalid('providers.type');
    }
    const type = provider.type as ProviderType;
    const baseURL = resolvedText(provider.baseURL, 'providers.baseURL', env);
    const apiKey = resolvedText(provider.apiKey, 'providers.apiKey', env);
    if (baseURL === undefined) invalid('providers.baseURL (required)');
    validURL(baseURL, 'providers.baseURL');
    if (apiKey !== undefined && /[\r\n]/.test(apiKey)) {
      invalid('providers.apiKey');
    }
    if (API_KEY_REQUIRED.has(type) && !apiKey) {
      invalid(`providers.apiKey (required for ${type})`);
    }
    result[providerId] = {
      type,
      baseURL,
      ...(apiKey === undefined ? {} : { apiKey }),
    };
  }
  return result;
}

function models(
  value: unknown,
  availableProviders: Readonly<Record<string, ProviderConfig>>,
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    invalid('models (required)');
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const modelId of value) {
    let parsed: ReturnType<typeof parseModelId>;
    try {
      parsed = parseModelId(modelId);
    } catch {
      return invalid('models identifier');
    }
    if (!(parsed.providerId in availableProviders)) {
      invalid('models provider');
    }
    if (seen.has(parsed.id)) invalid('models duplicate');
    seen.add(parsed.id);
    result.push(parsed.id);
  }
  return result;
}

export interface ResolveConfigOptions {
  fileConfig?: unknown;
  env?: Readonly<Record<string, string | undefined>>;
  overrides?: EasyAgentConfigInput;
}

/** Pure resolution; environment access belongs to loadConfig's initialization boundary. */
export function resolveConfig(
  options: ResolveConfigOptions = {},
): EasyAgentConfig {
  try {
    const env = options.env ?? {};
    const sources: unknown[] = [
      options.fileConfig,
      {
        ...(env.EASY_AGENT_DEFAULT_MODEL === undefined
          ? {}
          : { defaultModel: env.EASY_AGENT_DEFAULT_MODEL }),
        agent:
          env.EASY_AGENT_MAX_MODEL_RETRIES === undefined ||
          options.overrides?.agent?.maxModelRetries !== undefined
            ? {}
            : { maxModelRetries: envInteger(env.EASY_AGENT_MAX_MODEL_RETRIES) },
        cli:
          env.EASY_AGENT_STREAM === undefined ||
          options.overrides?.cli?.stream !== undefined
            ? {}
            : { stream: envBoolean(env.EASY_AGENT_STREAM) },
        logging:
          env.LOG_LEVEL === undefined
            ? {}
            : { level: env.LOG_LEVEL.trim().toLowerCase() },
      },
      options.overrides,
    ];
    let providerSource: unknown;
    let modelSource: unknown;
    let defaultModel: unknown;
    let agent: Record<string, unknown> = { maxModelRetries: 2 };
    let cli: Record<string, unknown> = { stream: true };
    let logging: Record<string, unknown> = { level: 'info' };
    for (const source of sources) {
      const root = section(source, [
        'providers',
        'models',
        'defaultModel',
        'agent',
        'cli',
        'logging',
      ]);
      if (root.providers !== undefined) providerSource = root.providers;
      if (root.models !== undefined) modelSource = root.models;
      if (root.defaultModel !== undefined) defaultModel = root.defaultModel;
      agent = { ...agent, ...section(root.agent, ['maxModelRetries']) };
      cli = { ...cli, ...section(root.cli, ['stream']) };
      logging = { ...logging, ...section(root.logging, ['level']) };
    }
    const resolvedProviders = providers(providerSource, env);
    const resolvedModels = models(modelSource, resolvedProviders);
    if (
      typeof defaultModel !== 'string' ||
      !resolvedModels.includes(defaultModel)
    ) {
      invalid('defaultModel (registered model required)');
    }
    if (
      typeof agent.maxModelRetries !== 'number' ||
      !Number.isSafeInteger(agent.maxModelRetries) ||
      agent.maxModelRetries < 0
    ) {
      invalid('agent.maxModelRetries');
    }
    if (typeof cli.stream !== 'boolean') invalid('cli.stream');
    if (
      typeof logging.level !== 'string' ||
      !['debug', 'info', 'warn', 'error'].includes(logging.level)
    ) {
      invalid('logging.level');
    }
    return {
      providers: resolvedProviders,
      models: resolvedModels,
      defaultModel,
      agent: { maxModelRetries: agent.maxModelRetries },
      cli: { stream: cli.stream },
      logging: { level: logging.level as LogLevel },
    };
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError();
  }
}
