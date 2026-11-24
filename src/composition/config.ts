import type { ModelParameters } from '../harness/contracts/model/index.ts';
import type { LogLevel } from '../runtime/logging/index.ts';

export interface EasyAgentConfig {
  model: {
    provider: 'openai-compatible';
    name: string;
    baseUrl?: string;
    apiKey?: string;
    parameters?: ModelParameters;
  };
  agent: { maxModelRetries: number };
  cli: { stream: boolean };
  logging: { level: LogLevel };
}

export interface EasyAgentConfigInput {
  model?: Partial<EasyAgentConfig['model']>;
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
  // Field names are fixed by this module, never derived from input values.
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
  if (!record(value) || Object.keys(value).some((key) => !keys.includes(key)))
    invalid('supported fields');
  return value;
}

function jsonCopy(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || value === null || seen.has(value))
    invalid('model.parameters JSON values');
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null)
    invalid('model.parameters JSON values');
  seen.add(value);
  try {
    if (Array.isArray(value))
      return Array.from(value, (item) => jsonCopy(item, seen));
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, jsonCopy(item, seen)]),
    );
  } finally {
    seen.delete(value);
  }
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
        model: {
          ...(env.EASY_AGENT_MODEL === undefined
            ? {}
            : { name: env.EASY_AGENT_MODEL }),
          ...(env.EASY_AGENT_BASE_URL === undefined
            ? {}
            : { baseUrl: env.EASY_AGENT_BASE_URL }),
          ...(env.OPENAI_API_KEY === undefined
            ? {}
            : { apiKey: env.OPENAI_API_KEY }),
        },
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
    let model: Record<string, unknown> = { provider: 'openai-compatible' };
    let agent: Record<string, unknown> = { maxModelRetries: 2 };
    let cli: Record<string, unknown> = { stream: true };
    let logging: Record<string, unknown> = { level: 'info' };
    for (const source of sources) {
      const root = section(source, ['model', 'agent', 'cli', 'logging']);
      const nextModel = section(root.model, [
        'provider',
        'name',
        'baseUrl',
        'apiKey',
        'parameters',
      ]);
      const parameters =
        nextModel.parameters === undefined
          ? model.parameters
          : {
              ...section(
                model.parameters,
                Object.keys(record(model.parameters) ? model.parameters : {}),
              ),
              ...section(
                nextModel.parameters,
                Object.keys(
                  record(nextModel.parameters) ? nextModel.parameters : {},
                ),
              ),
            };
      model = {
        ...model,
        ...nextModel,
        ...(parameters === undefined ? {} : { parameters }),
      };
      agent = { ...agent, ...section(root.agent, ['maxModelRetries']) };
      cli = { ...cli, ...section(root.cli, ['stream']) };
      logging = { ...logging, ...section(root.logging, ['level']) };
    }
    if (model.provider !== 'openai-compatible') invalid('model.provider');
    if (typeof model.name !== 'string' || !model.name.trim())
      invalid('model.name (required)');
    if (model.baseUrl !== undefined) {
      if (typeof model.baseUrl !== 'string') invalid('model.baseUrl');
      let url: URL;
      try {
        url = new URL(model.baseUrl);
      } catch {
        return invalid('model.baseUrl');
      }
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        invalid('model.baseUrl');
    }
    if (
      model.apiKey !== undefined &&
      (typeof model.apiKey !== 'string' || /[\r\n]/.test(model.apiKey))
    )
      invalid('model.apiKey');
    if (
      typeof agent.maxModelRetries !== 'number' ||
      !Number.isSafeInteger(agent.maxModelRetries) ||
      agent.maxModelRetries < 0
    )
      invalid('agent.maxModelRetries');
    if (typeof cli.stream !== 'boolean') invalid('cli.stream');
    if (
      typeof logging.level !== 'string' ||
      !['debug', 'info', 'warn', 'error'].includes(logging.level)
    )
      invalid('logging.level');
    const parameters =
      model.parameters === undefined
        ? undefined
        : (jsonCopy(model.parameters) as ModelParameters);
    if (
      parameters?.temperature !== undefined &&
      (typeof parameters.temperature !== 'number' ||
        parameters.temperature < 0 ||
        parameters.temperature > 2)
    )
      invalid('model.parameters.temperature');
    if (
      parameters?.maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(parameters.maxOutputTokens) ||
        parameters.maxOutputTokens < 1)
    )
      invalid('model.parameters.maxOutputTokens');
    return {
      model: {
        provider: 'openai-compatible',
        name: model.name,
        ...(model.baseUrl === undefined
          ? {}
          : { baseUrl: model.baseUrl as string }),
        ...(model.apiKey === undefined
          ? {}
          : { apiKey: model.apiKey as string }),
        ...(parameters === undefined ? {} : { parameters }),
      },
      agent: { maxModelRetries: agent.maxModelRetries },
      cli: { stream: cli.stream },
      logging: { level: logging.level as LogLevel },
    };
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError();
  }
}
