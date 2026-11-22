import type { AgentLoopContext } from '../../harness/contracts/agent-loop/index.ts';
import type {
  ModelParameters,
  ModelToolDefinition,
} from '../../harness/contracts/model/index.ts';
import type { ToolRegistry } from '../../harness/contracts/tool/index.ts';
import { toModelToolDefinition } from '../../runtime/tool/model-bridge.ts';
import {
  copyData,
  copyHistory,
  invalidContext,
  object,
  text,
  toolName,
} from './snapshots.ts';

export interface DefaultAgentLoopOptions {
  maxModelRetries?: number;
  modelTimeoutMs?: number;
  toolTimeoutMs?: number;
}

export function prepare(context: AgentLoopContext, registry: ToolRegistry) {
  if (!object(context)) return invalidContext();
  const { input, context: history, config, control } = context;
  if (!object(input) || !object(history) || !object(config) || !object(control))
    return invalidContext();
  const { content } = input;
  const modelConfig = config.model;
  const signal = control.signal;
  if (
    typeof content !== 'string' ||
    !object(modelConfig) ||
    !(signal instanceof AbortSignal)
  )
    return invalidContext();
  const model = modelConfig.name;
  const rawParameters = modelConfig.parameters;
  if (!text(model)) return invalidContext();
  const extensions = config.extensions;
  if (extensions !== undefined && !object(extensions)) return invalidContext();
  const extension = extensions?.defaultAgentLoop;
  if (extension !== undefined && !object(extension)) return invalidContext();
  const raw = extension === undefined ? {} : copyData(extension);
  if (!object(raw)) return invalidContext();
  const { maxModelRetries: retries, modelTimeoutMs, toolTimeoutMs } = raw;
  const maxModelRetries = retries === undefined ? 2 : retries;
  if (
    typeof maxModelRetries !== 'number' ||
    !Number.isSafeInteger(maxModelRetries) ||
    maxModelRetries < 0
  )
    return invalidContext();
  for (const value of [modelTimeoutMs, toolTimeoutMs]) {
    if (
      value !== undefined &&
      (typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value <= 0 ||
        value > 2_147_483_647)
    )
      return invalidContext();
  }
  const options: Required<Pick<DefaultAgentLoopOptions, 'maxModelRetries'>> &
    DefaultAgentLoopOptions = {
    maxModelRetries,
    ...(modelTimeoutMs === undefined
      ? {}
      : { modelTimeoutMs: modelTimeoutMs as number }),
    ...(toolTimeoutMs === undefined
      ? {}
      : { toolTimeoutMs: toolTimeoutMs as number }),
  };
  const messages = copyHistory(history.messages);
  messages.push({ role: 'user', content });
  const parameters =
    rawParameters === undefined
      ? undefined
      : (copyData(rawParameters) as ModelParameters);
  if (parameters !== undefined && !object(parameters)) return invalidContext();
  const toolConfig = config.tools;
  if (toolConfig !== undefined && !object(toolConfig)) return invalidContext();
  const rawAllowed = toolConfig?.allowedNames;
  if (rawAllowed !== undefined && !Array.isArray(rawAllowed))
    return invalidContext();
  const allowed: unknown[] | undefined =
    rawAllowed === undefined ? undefined : [...rawAllowed];
  if (allowed !== undefined && !allowed.every(toolName))
    return invalidContext();
  const definitions: ModelToolDefinition[] = registry
    .list()
    .map(toModelToolDefinition);
  const names = new Set(definitions.map((tool) => tool.name));
  if (names.size !== definitions.length) return invalidContext();
  if (allowed?.some((name) => typeof name !== 'string' || !names.has(name)))
    throw new Error('An allowed tool is not registered.');
  const selected =
    allowed === undefined
      ? definitions
      : definitions.filter((tool) => allowed.includes(tool.name));
  const allowedNames = new Set(selected.map((tool) => tool.name));
  return {
    messages,
    model,
    parameters,
    options,
    definitions: selected,
    allowedNames,
    signal,
    data: history.data,
  };
}
