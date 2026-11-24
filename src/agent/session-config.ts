import type { AgentLoopContext } from '../harness/contracts/agent-loop/index.ts';
import type { SessionSubmitOptions } from '../harness/contracts/agent/index.ts';
import type { ModelParameters } from '../harness/contracts/model/index.ts';
import { snapshot } from './snapshots.ts';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function invalidInput(): never {
  throw new Error('Invalid session input or configuration.');
}
export function validId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

type PartialConfig = NonNullable<SessionSubmitOptions['config']>;

/** Only the public container shape is interpreted; provider/Loop policies remain downstream. */
export function configSnapshot(
  value: unknown,
  partial: boolean,
): PartialConfig {
  try {
    if (value === undefined) return {};
    if (!record(value)) return invalidInput();
    const { model, tools, extensions } = value;
    let copiedModel: PartialConfig['model'];
    let copiedTools: PartialConfig['tools'];
    if (model !== undefined) {
      if (!record(model)) return invalidInput();
      const { name, parameters } = model;
      if (
        (name !== undefined && typeof name !== 'string') ||
        (!partial && typeof name !== 'string') ||
        (parameters !== undefined && !record(parameters))
      )
        return invalidInput();
      copiedModel = {
        ...(name === undefined ? {} : { name }),
        ...(parameters === undefined
          ? {}
          : { parameters: parameters as ModelParameters }),
      };
    }
    if (tools !== undefined) {
      if (!record(tools)) return invalidInput();
      const allowedNames = tools.allowedNames;
      if (allowedNames !== undefined && !Array.isArray(allowedNames))
        return invalidInput();
      const names: string[] = [];
      if (allowedNames !== undefined)
        for (const name of allowedNames) {
          if (typeof name !== 'string') return invalidInput();
          names.push(name);
        }
      copiedTools = allowedNames === undefined ? {} : { allowedNames: names };
    }
    if (extensions !== undefined && !record(extensions)) return invalidInput();
    return snapshot({
      ...(copiedModel === undefined ? {} : { model: copiedModel }),
      ...(copiedTools === undefined ? {} : { tools: copiedTools }),
      ...(extensions === undefined ? {} : { extensions }),
    });
  } catch {
    return invalidInput();
  }
}

/** Merge dictionary keys without evaluating unknown namespace/parameter accessors. */
function mergeFields(
  base: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const descriptors = {
    ...Object.getOwnPropertyDescriptors(base),
    ...Object.getOwnPropertyDescriptors(overrides),
  };
  return Object.defineProperties({}, descriptors);
}

export function resolveConfig(
  base: PartialConfig,
  overrides: PartialConfig,
): AgentLoopContext['config'] {
  const name = overrides.model?.name ?? base.model?.name;
  const baseParameters = base.model?.parameters;
  const parameters = overrides.model?.parameters;
  const hasModel =
    name !== undefined ||
    baseParameters !== undefined ||
    parameters !== undefined;
  if (hasModel && typeof name !== 'string') return invalidInput();
  const tools =
    overrides.tools?.allowedNames !== undefined
      ? { allowedNames: overrides.tools.allowedNames }
      : base.tools;
  const config: AgentLoopContext['config'] = {
    ...(hasModel
      ? {
          model: {
            name: name!,
            ...(baseParameters === undefined && parameters === undefined
              ? {}
              : { parameters: mergeFields(baseParameters, parameters) }),
          },
        }
      : {}),
    ...(tools === undefined ? {} : { tools }),
    ...(base.extensions === undefined && overrides.extensions === undefined
      ? {}
      : { extensions: mergeFields(base.extensions, overrides.extensions) }),
  };
  return snapshot(config);
}
