import type {
  AgentLoopContext,
  AgentLoopEvent,
  AgentLoopResult,
} from '../../harness/contracts/agent-loop/index.ts';
import type { ExecutionRequest } from '../../harness/contracts/execution/index.ts';
import { recordSnapshot, snapshot } from './snapshots.ts';

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
export function startupError(): never {
  throw new Error('Invalid execution request.');
}
const protocolErrors = new WeakSet<object>();
export class ProtocolError extends Error {
  constructor() {
    super('Agent loop violated its lifecycle contract.');
    protocolErrors.add(this);
  }
}
export function isProtocolError(error: unknown): boolean {
  return (typeof error === 'object' && error !== null) ||
    typeof error === 'function'
    ? protocolErrors.has(error)
    : false;
}

/** Materialize only public schema fields; unknown payload accessors remain opaque. */
function normalized(
  source: Record<string, unknown>,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const descriptors = Object.getOwnPropertyDescriptors(source);
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor)
      Object.defineProperty(result, key, { ...descriptor, configurable: true });
  }
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined || Object.hasOwn(source, key))
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  return result;
}

function captureMessages(
  value: unknown,
  replacements: WeakMap<object, object>,
): boolean {
  if (!Array.isArray(value)) return false;
  const messages: unknown[] = [];
  for (const item of value) {
    if (!record(item)) return false;
    const { role, content } = item;
    let fields: Record<string, unknown>;
    if (role === 'system' || role === 'user') {
      if (typeof content !== 'string') return false;
      fields = { role, content };
    } else if (role === 'assistant') {
      if (content !== null && typeof content !== 'string') return false;
      const toolCalls = item.toolCalls;
      if (toolCalls !== undefined) {
        if (!Array.isArray(toolCalls)) return false;
        const calls: unknown[] = [];
        for (const call of toolCalls) {
          if (!record(call)) return false;
          const { id, name, argumentsJson } = call;
          if (
            typeof id !== 'string' ||
            typeof name !== 'string' ||
            typeof argumentsJson !== 'string'
          )
            return false;
          replacements.set(call, normalized(call, { id, name, argumentsJson }));
          calls.push(call);
        }
        replacements.set(toolCalls, calls);
      }
      fields = { role, content, toolCalls };
    } else if (role === 'tool') {
      const { toolCallId, isError } = item;
      if (
        typeof content !== 'string' ||
        typeof toolCallId !== 'string' ||
        (isError !== undefined && typeof isError !== 'boolean')
      )
        return false;
      fields = { role, content, toolCallId, isError };
    } else return false;
    replacements.set(item, normalized(item, fields));
    messages.push(item);
  }
  replacements.set(value, messages);
  return true;
}

function captureContext(
  value: unknown,
  replacements: WeakMap<object, object>,
): value is AgentLoopContext['context'] {
  if (!record(value)) return false;
  const { messages, data } = value;
  if (
    !captureMessages(messages, replacements) ||
    (data !== undefined && !record(data))
  )
    return false;
  replacements.set(value, normalized(value, { messages, data }));
  return true;
}

export function prepare(request: ExecutionRequest): {
  executionId: string;
  loop: ExecutionRequest['loop'];
  context: AgentLoopContext;
  signal: AbortSignal;
} {
  try {
    if (!record(request)) return startupError();
    const { executionId, loop, context } = request;
    if (
      !nonempty(executionId) ||
      (!record(loop) && typeof loop !== 'function') ||
      !record(context)
    )
      return startupError();
    const run: unknown = loop.run;
    if (typeof run !== 'function') return startupError();
    const { input, context: history, config, control, metadata } = context;
    const replacements = new WeakMap<object, object>();
    if (
      !record(input) ||
      !captureContext(history, replacements) ||
      !record(config) ||
      !record(control)
    )
      return startupError();
    const content: unknown = input.content;
    const signal: unknown = control.signal;
    if (typeof content !== 'string' || !(signal instanceof AbortSignal))
      return startupError();
    const model = config.model;
    const tools = config.tools;
    const extensions = config.extensions;
    if (model !== undefined) {
      if (!record(model)) return startupError();
      const name = model.name;
      const parameters = model.parameters;
      if (
        typeof name !== 'string' ||
        (parameters !== undefined && !record(parameters))
      )
        return startupError();
      replacements.set(model, normalized(model, { name, parameters }));
    }
    if (tools !== undefined) {
      if (!record(tools)) return startupError();
      const allowedNames = tools.allowedNames;
      if (allowedNames !== undefined) {
        if (!Array.isArray(allowedNames)) return startupError();
        const names: unknown[] = [];
        for (const name of allowedNames) {
          if (typeof name !== 'string') return startupError();
          names.push(name);
        }
        replacements.set(allowedNames, names);
      }
      replacements.set(tools, normalized(tools, { allowedNames }));
    }
    if (extensions !== undefined && !record(extensions)) return startupError();
    if (metadata !== undefined && !record(metadata)) return startupError();
    const metadataId = metadata?.executionId;
    const sessionId = metadata?.sessionId;
    if (
      (metadataId !== undefined && metadataId !== executionId) ||
      (sessionId !== undefined && typeof sessionId !== 'string')
    )
      return startupError();
    const copiedMetadata = normalized(metadata ?? {}, {
      executionId,
      sessionId,
    });
    if (metadata) replacements.set(metadata, copiedMetadata);
    replacements.set(input, normalized(input, { content }));
    replacements.set(config, normalized(config, { model, tools, extensions }));
    replacements.set(control, normalized(control, { signal }));
    replacements.set(
      context,
      normalized(context, {
        input,
        context: history,
        config,
        control,
        metadata: metadata ?? copiedMetadata,
      }),
    );
    const copied = snapshot(context, replacements) as AgentLoopContext;
    return {
      executionId,
      loop: {
        run: (value) =>
          Reflect.apply(run, loop, [value]) as ReturnType<
            ExecutionRequest['loop']['run']
          >,
      },
      context: copied,
      signal,
    };
  } catch {
    return startupError();
  }
}

export function loopResult(value: unknown): AgentLoopResult {
  try {
    if (!record(value)) throw new ProtocolError();
    const status = value.status;
    if (status !== 'completed' && status !== 'stopped')
      throw new ProtocolError();
    const output = value.output;
    const reason = status === 'stopped' ? value.reason : undefined;
    const updatedContext = value.updatedContext;
    const details = value.details;
    if (
      status === 'completed'
        ? typeof output !== 'string'
        : typeof reason !== 'string' ||
          (output !== undefined && typeof output !== 'string')
    )
      throw new ProtocolError();
    if (details !== undefined && !record(details)) throw new ProtocolError();
    const replacements = new WeakMap<object, object>();
    if (
      updatedContext !== undefined &&
      !captureContext(updatedContext, replacements)
    )
      throw new ProtocolError();
    replacements.set(
      value,
      normalized(value, {
        status,
        output,
        ...(status === 'stopped' ? { reason } : {}),
        updatedContext,
        details,
      }),
    );
    return snapshot(value, replacements) as AgentLoopResult;
  } catch {
    throw new ProtocolError();
  }
}

export class LoopProtocol {
  private started = false;
  private ended: AgentLoopResult | undefined;

  accept(value: unknown): AgentLoopEvent {
    if (!record(value) || this.ended) throw new ProtocolError();
    const type = value.type;
    if (!this.started) {
      if (type !== 'loop_start') throw new ProtocolError();
      this.started = true;
    } else if (type === 'loop_start') throw new ProtocolError();
    if (type === 'loop_end') this.ended = loopResult(value.result);
    else if (type === 'output_delta') {
      if (typeof value.content !== 'string') throw new ProtocolError();
    } else if (type === 'custom_event') {
      if (typeof value.name !== 'string' || !Object.hasOwn(value, 'data'))
        throw new ProtocolError();
    } else if (type === 'model_event') {
      if (
        !Number.isSafeInteger(value.modelCallIndex) ||
        Number(value.modelCallIndex) < 1 ||
        !record(value.event)
      )
        throw new ProtocolError();
    } else if (type === 'tool_start') {
      if (
        !Number.isSafeInteger(value.modelCallIndex) ||
        Number(value.modelCallIndex) < 1 ||
        !record(value.call)
      )
        throw new ProtocolError();
    } else if (type === 'tool_result') {
      if (
        !Number.isSafeInteger(value.modelCallIndex) ||
        Number(value.modelCallIndex) < 1 ||
        !record(value.result)
      )
        throw new ProtocolError();
    } else if (type !== 'loop_start') throw new ProtocolError();
    const copied = recordSnapshot(value);
    Object.defineProperty(copied, 'type', {
      value: type,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    if (type === 'loop_end')
      Object.defineProperty(copied, 'result', {
        value: snapshot(this.ended),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return copied as AgentLoopEvent;
  }

  result(): AgentLoopResult {
    if (!this.started || !this.ended) throw new ProtocolError();
    return snapshot(this.ended);
  }
}
