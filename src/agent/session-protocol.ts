import type { AgentLoopContext } from '../harness/contracts/agent-loop/index.ts';
import type {
  ExecutionEvent,
  ExecutionResult,
} from '../harness/contracts/execution/index.ts';
import { record, invalidInput } from './session-config.ts';
import { snapshot } from './snapshots.ts';

function normalized(
  source: Record<string, unknown>,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (descriptor)
      Object.defineProperty(result, key, { ...descriptor, configurable: true });
  }
  for (const [key, value] of Object.entries(fields))
    if (value !== undefined || Object.hasOwn(source, key))
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  return result;
}

function captureContext(
  value: unknown,
  materialized: WeakMap<object, object>,
): void {
  if (!record(value)) return invalidInput();
  const { messages, data } = value;
  if (!Array.isArray(messages) || (data !== undefined && !record(data)))
    return invalidInput();
  const copied: unknown[] = [];
  for (const message of messages) {
    if (!record(message)) return invalidInput();
    const { role, content } = message;
    let fields: Record<string, unknown>;
    if (role === 'system' || role === 'user') {
      if (typeof content !== 'string') return invalidInput();
      fields = { role, content };
    } else if (role === 'assistant') {
      if (content !== null && typeof content !== 'string')
        return invalidInput();
      const toolCalls = message.toolCalls;
      if (toolCalls !== undefined) {
        if (!Array.isArray(toolCalls)) return invalidInput();
        const calls: unknown[] = [];
        for (const call of toolCalls) {
          if (!record(call)) return invalidInput();
          const { id, name, argumentsJson } = call;
          if (
            typeof id !== 'string' ||
            typeof name !== 'string' ||
            typeof argumentsJson !== 'string'
          )
            return invalidInput();
          materialized.set(call, normalized(call, { id, name, argumentsJson }));
          calls.push(call);
        }
        materialized.set(toolCalls, calls);
      }
      fields = { role, content, toolCalls };
    } else if (role === 'tool') {
      const { toolCallId, isError } = message;
      if (
        typeof content !== 'string' ||
        typeof toolCallId !== 'string' ||
        (isError !== undefined && typeof isError !== 'boolean')
      )
        return invalidInput();
      fields = { role, content, toolCallId, isError };
    } else return invalidInput();
    materialized.set(message, normalized(message, fields));
    copied.push(message);
  }
  materialized.set(messages, copied);
  materialized.set(value, normalized(value, { messages, data }));
}

export function contextSnapshot(value: unknown): AgentLoopContext['context'] {
  try {
    const materialized = new WeakMap<object, object>();
    captureContext(value, materialized);
    return snapshot(value, materialized) as AgentLoopContext['context'];
  } catch {
    return invalidInput();
  }
}

function captureLoop(
  value: unknown,
  materialized: WeakMap<object, object>,
): 'completed' | 'stopped' {
  if (!record(value)) return invalidInput();
  const status = value.status;
  if (status !== 'completed' && status !== 'stopped') return invalidInput();
  const output = value.output;
  const reason = status === 'stopped' ? value.reason : undefined;
  const details = value.details;
  const updatedContext = value.updatedContext;
  if (
    status === 'completed'
      ? typeof output !== 'string'
      : typeof reason !== 'string' ||
        (output !== undefined && typeof output !== 'string')
  )
    return invalidInput();
  if (details !== undefined && !record(details)) return invalidInput();
  if (updatedContext !== undefined)
    captureContext(updatedContext, materialized);
  materialized.set(
    value,
    normalized(value, {
      status,
      output,
      ...(status === 'stopped' ? { reason } : {}),
      details,
      updatedContext,
    }),
  );
  return status;
}

export function executionResult(value: unknown): ExecutionResult {
  if (!record(value)) return invalidInput();
  const status = value.status;
  const materialized = new WeakMap<object, object>();
  let fields: Record<string, unknown>;
  if (status === 'CANCELLED') {
    const reason = value.reason;
    if (reason !== undefined && typeof reason !== 'string')
      return invalidInput();
    fields = { status, reason };
  } else {
    const loopResult = value.loopResult;
    const loopStatus =
      loopResult === undefined
        ? undefined
        : captureLoop(loopResult, materialized);
    if (status === 'COMPLETED') {
      if (loopStatus !== 'completed') return invalidInput();
      fields = { status, loopResult };
    } else {
      if (status !== 'FAILED') return invalidInput();
      const error = value.error;
      if (!record(error)) return invalidInput();
      const { code, message } = error;
      if (
        typeof code !== 'string' ||
        ![
          'loop_stopped',
          'loop_protocol_error',
          'loop_error',
          'internal_error',
        ].includes(code) ||
        typeof message !== 'string'
      )
        return invalidInput();
      materialized.set(error, normalized(error, { code, message }));
      fields = { status, error, loopResult };
    }
  }
  // Only the public result envelope is retained. In particular, an undeclared
  // root `then` must never take ownership of SessionExecution.result resolution.
  // Nested details/data remain opaque data graphs and retain all their fields.
  materialized.set(value, fields);
  return snapshot(value, materialized) as ExecutionResult;
}

export function internalFailure(): ExecutionResult {
  return {
    status: 'FAILED',
    error: {
      code: 'internal_error',
      message: 'Session execution could not be completed.',
    },
  };
}

/** Preserve actual Engine events; only a unique terminal result followed by EOF can commit. */
export class EngineEvents {
  private started = false;
  private ended: ExecutionResult | undefined;
  private readonly id: string;
  constructor(executionId: string) {
    this.id = executionId;
  }
  accept(value: unknown): ExecutionEvent {
    if (!record(value) || this.ended) return invalidInput();
    const { type, executionId } = value;
    if (executionId !== this.id) return invalidInput();
    if (type === 'execution_start') {
      const timestamp = value.timestamp;
      if (this.started || typeof timestamp !== 'string') return invalidInput();
      this.started = true;
      return { type, executionId: this.id, timestamp };
    }
    if (!this.started) return invalidInput();
    if (type === 'loop_event') {
      const event = value.event;
      if (!record(event)) return invalidInput();
      return snapshot({ type, executionId: this.id, event }) as ExecutionEvent;
    }
    const timestamp = value.timestamp;
    if (type !== 'execution_end' || typeof timestamp !== 'string')
      return invalidInput();
    this.ended = executionResult(value.result);
    return {
      type,
      executionId: this.id,
      timestamp,
      result: snapshot(this.ended),
    };
  }
  result(): ExecutionResult {
    if (!this.started || !this.ended) return invalidInput();
    return snapshot(this.ended);
  }
}
