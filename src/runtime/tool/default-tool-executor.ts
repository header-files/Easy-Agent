import { randomUUID } from 'node:crypto';
import {
  type ToolCall,
  type ToolErrorCode,
  type ToolExecutor,
  type ToolExecutionOptions,
  type ToolRegistry,
  type ToolResult,
} from '../../harness/contracts/tool/index.ts';
import { createLogger, type Logger, type LogLevel } from '../logging/index.ts';
import { safeFields } from '../logging/redact.ts';
import { ExecutionControl, copyOptions } from './execution-control.ts';
import {
  argumentObject,
  compileToolSchema,
  copyToolSpec,
  validToolName,
} from './tool-validator.ts';

export interface DefaultToolExecutorOptions {
  logger?: Logger;
}

const errorMessages: Record<ToolErrorCode, string> = {
  tool_not_found: 'Tool was not found.',
  invalid_arguments: 'Tool arguments or execution options are invalid.',
  execution_failed: 'Tool execution failed.',
};

function errorResult(
  toolCallId: string,
  name: string,
  code: ToolErrorCode,
): ToolResult {
  const message = errorMessages[code];
  return {
    toolCallId,
    name,
    status: 'error',
    content: message,
    error: { code, message },
  };
}

/** Each invocation owns its arguments, cancellation state and registration snapshot. */
export class DefaultToolExecutor implements ToolExecutor {
  private readonly registry: ToolRegistry;
  private readonly logger: Logger | undefined;

  constructor(
    registry: ToolRegistry,
    options: DefaultToolExecutorOptions = {},
  ) {
    this.registry = registry;
    try {
      this.logger =
        options.logger === undefined
          ? createLogger({ module: 'runtime.tool.executor' })
          : options.logger.child('runtime.tool.executor');
    } catch {
      this.logger = undefined;
    }
  }

  async execute(
    call: ToolCall,
    options?: ToolExecutionOptions,
  ): Promise<ToolResult> {
    const executionId = randomUUID();
    const started = performance.now();
    let toolCallId = '';
    let name = '';
    let control: ExecutionControl | undefined;
    let result: ToolResult | undefined;
    const log = (
      level: LogLevel,
      event: string,
      fields: Record<string, unknown> = {},
    ): void => {
      try {
        const outcome: unknown = this.logger?.[level](
          'Tool execution lifecycle',
          safeFields({
            executionId,
            event,
            ...(validToolName(name) ? { name } : {}),
            ...fields,
          }),
        );
        if (outcome !== undefined)
          void Promise.resolve(outcome).catch(() => {});
      } catch {
        /* Diagnostics cannot determine the execution outcome. */
      }
    };
    log('debug', 'tool.execution.started');
    try {
      let argumentsJson: unknown;
      try {
        if (argumentObject(call)) {
          const id: unknown = call.id;
          const toolName: unknown = call.name;
          argumentsJson = call.argumentsJson;
          if (typeof id === 'string') toolCallId = id;
          if (typeof toolName === 'string') name = toolName;
        }
      } catch {
        result = errorResult(toolCallId, name, 'invalid_arguments');
        return result;
      }
      const executionOptions = copyOptions(options);
      if (
        !argumentObject(call) ||
        toolCallId.trim().length === 0 ||
        !validToolName(name) ||
        typeof argumentsJson !== 'string' ||
        executionOptions === undefined
      ) {
        result = errorResult(toolCallId, name, 'invalid_arguments');
        return result;
      }
      control = new ExecutionControl(executionOptions);
      control.check();
      // Exactly one lookup before awaiting: later unregister/re-register cannot replace this handler.
      const registered = this.registry.get(name);
      control.check();
      if (registered === undefined) {
        result = errorResult(toolCallId, name, 'tool_not_found');
        return result;
      }
      const spec = copyToolSpec(registered.spec);
      const handler = registered.handler;
      if (typeof handler !== 'function' || spec.name !== name)
        throw new Error();
      const validate = compileToolSchema(spec.parameters);
      let args: unknown;
      try {
        args = JSON.parse(argumentsJson) as unknown;
      } catch {
        control.check();
        result = errorResult(toolCallId, name, 'invalid_arguments');
        return result;
      }
      control.check();
      if (!argumentObject(args) || !validate(args)) {
        control.check();
        result = errorResult(toolCallId, name, 'invalid_arguments');
        return result;
      }
      const context = { toolCallId, signal: control.signal };
      const output: unknown = await control.run(() => handler(args, context));
      const content: unknown = argumentObject(output)
        ? output.content
        : undefined;
      if (typeof content !== 'string') throw new Error();
      control.check();
      result = { toolCallId, name, status: 'success', content };
      return result;
    } catch {
      const interruption = control?.interruption();
      if (interruption) {
        log('warn', 'tool.execution.cancelled', {
          code: interruption.code,
          durationMs: Math.max(0, performance.now() - started),
        });
        throw interruption;
      }
      result = errorResult(toolCallId, name, 'execution_failed');
      return result;
    } finally {
      control?.dispose();
      if (result) {
        log(
          result.status === 'success'
            ? 'info'
            : result.error.code === 'execution_failed'
              ? 'error'
              : 'warn',
          'tool.execution.completed',
          {
            status: result.status,
            durationMs: Math.max(0, performance.now() - started),
            ...(result.status === 'error' ? { code: result.error.code } : {}),
          },
        );
      }
    }
  }
}
