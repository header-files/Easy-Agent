import { randomUUID } from 'node:crypto';
import {
  ToolExecutionError,
  type ToolCall,
  type ToolErrorCode,
  type ToolExecutor,
  type ToolExecutionOptions,
  type ToolResult,
} from '../../harness/contracts/tool/index.ts';
import { ApprovalError, type ApprovalService } from '../approval/index.ts';
import { createLogger, type Logger, type LogLevel } from '../logging/index.ts';
import { safeFields } from '../logging/redact.ts';
import {
  WorkspaceError,
  type WorkspaceAccessCoordinator,
} from '../workspace/index.ts';
import type { DefaultToolRegistry } from './default-tool-registry.ts';
import { ExecutionControl, copyOptions } from './execution-control.ts';
import { DEFAULT_TOOL_META } from './tool-meta.ts';
import {
  argumentObject,
  compileToolSchema,
  copyToolSpec,
  validToolName,
} from './tool-validator.ts';

export interface GuardedToolExecutorOptions {
  logger?: Logger;
  approval?: ApprovalService;
  coordinator?: WorkspaceAccessCoordinator;
  /** Default approval wait when options omit approvalTimeoutMs. */
  approvalTimeoutMs?: number;
  /** After timeout/abort, wait this long for the handler before marking UNSAFE. */
  handlerSettleGraceMs?: number;
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
  message = errorMessages[code],
): ToolResult {
  return {
    toolCallId,
    name,
    status: 'error',
    content: message,
    error: { code, message },
  };
}

/**
 * Validate → approve (no lock / no tool timeout) → workspace lock → handler
 * with a fresh tool timeout. Terminal cleanup/UNSAFE is owned by handlers.
 */
export class GuardedToolExecutor implements ToolExecutor {
  private readonly registry: DefaultToolRegistry;
  private readonly approval: ApprovalService | undefined;
  private readonly coordinator: WorkspaceAccessCoordinator | undefined;
  private readonly defaultApprovalTimeoutMs: number | undefined;
  private readonly handlerSettleGraceMs: number;
  private readonly logger: Logger | undefined;

  constructor(
    registry: DefaultToolRegistry,
    options: GuardedToolExecutorOptions = {},
  ) {
    this.registry = registry;
    this.approval = options.approval;
    this.coordinator = options.coordinator;
    this.defaultApprovalTimeoutMs = options.approvalTimeoutMs ?? 120_000;
    this.handlerSettleGraceMs = options.handlerSettleGraceMs ?? 5_000;
    try {
      this.logger =
        options.logger === undefined
          ? createLogger({ module: 'runtime.tool.guarded' })
          : options.logger.child('runtime.tool.guarded');
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
    let result: ToolResult | undefined;
    const log = (
      level: LogLevel,
      event: string,
      fields: Record<string, unknown> = {},
    ): void => {
      try {
        const outcome: unknown = this.logger?.[level](
          'Guarded tool execution lifecycle',
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
      if (executionOptions.signal?.aborted) {
        throw new ToolExecutionError('aborted', 'Tool execution was aborted.');
      }
      const registered = this.registry.get(name);
      if (registered === undefined) {
        result = errorResult(toolCallId, name, 'tool_not_found');
        return result;
      }
      const spec = copyToolSpec(registered.spec);
      const handler = registered.handler;
      const meta = this.registry.getMeta(name) ?? DEFAULT_TOOL_META;
      if (typeof handler !== 'function' || spec.name !== name)
        throw new Error();
      const validate = compileToolSchema(spec.parameters);
      let args: unknown;
      try {
        args = JSON.parse(argumentsJson) as unknown;
      } catch {
        result = errorResult(toolCallId, name, 'invalid_arguments');
        return result;
      }
      if (!argumentObject(args) || !validate(args)) {
        result = errorResult(toolCallId, name, 'invalid_arguments');
        return result;
      }

      if (meta.approval === 'always') {
        if (this.approval === undefined) {
          result = errorResult(
            toolCallId,
            name,
            'execution_failed',
            'No approval channel is available.',
          );
          return result;
        }
        const approvalTimeout =
          executionOptions.approvalTimeoutMs ?? this.defaultApprovalTimeoutMs;
        try {
          const approved = await this.approval.require({
            toolCallId,
            toolName: name,
            args,
            executionId: executionOptions.executionId ?? executionId,
            ...(executionOptions.workspaceId === undefined
              ? {}
              : { workspaceId: executionOptions.workspaceId }),
            ...(executionOptions.signal === undefined
              ? {}
              : { signal: executionOptions.signal }),
            ...(approvalTimeout === undefined
              ? {}
              : { timeoutMs: approvalTimeout }),
          });
          // Handler must use the frozen approved snapshot, not the mutable parse object.
          args = approved.arguments as Record<string, unknown>;
        } catch (error) {
          if (error instanceof ApprovalError) {
            if (error.code === 'cancelled') {
              throw new ToolExecutionError(
                'aborted',
                'Tool execution was aborted.',
              );
            }
            result = errorResult(
              toolCallId,
              name,
              'execution_failed',
              error.message,
            );
            return result;
          }
          throw error;
        }
      }

      if (executionOptions.signal?.aborted) {
        throw new ToolExecutionError('aborted', 'Tool execution was aborted.');
      }

      const holdsWorkspace =
        meta.workspaceAccess !== 'none' &&
        this.coordinator !== undefined &&
        executionOptions.workspaceId !== undefined;

      const runHandler = async (): Promise<ToolResult> => {
        const control = new ExecutionControl({
          ...(executionOptions.signal === undefined
            ? {}
            : { signal: executionOptions.signal }),
          ...(executionOptions.timeoutMs === undefined
            ? {}
            : { timeoutMs: executionOptions.timeoutMs }),
        });
        try {
          control.check();
          const context = {
            toolCallId,
            signal: control.signal,
            ...(executionOptions.workspaceId === undefined
              ? {}
              : { workspaceId: executionOptions.workspaceId }),
            ...(executionOptions.sessionId === undefined
              ? {}
              : { sessionId: executionOptions.sessionId }),
            ...(executionOptions.executionId === undefined
              ? {}
              : { executionId: executionOptions.executionId }),
          };
          // Hold the Workspace lock until the handler settles (or grace+UNSAFE).
          // Plain Promise.race would release the lock while Terminal/FS may still run.
          const output: unknown = await control.runUntilSettled(
            () => handler(args as Record<string, unknown>, context),
            {
              graceMs: this.handlerSettleGraceMs,
              onAbandoned: () => {
                if (
                  holdsWorkspace &&
                  executionOptions.workspaceId !== undefined &&
                  this.coordinator !== undefined
                ) {
                  this.coordinator.markUnsafe(executionOptions.workspaceId);
                }
              },
            },
          );
          const content: unknown = argumentObject(output)
            ? output.content
            : undefined;
          if (typeof content !== 'string') throw new Error();
          control.check();
          return { toolCallId, name, status: 'success', content };
        } catch (error) {
          const interruption = control.interruption();
          if (interruption) throw interruption;
          if (error instanceof ToolExecutionError) throw error;
          return errorResult(toolCallId, name, 'execution_failed');
        } finally {
          control.dispose();
        }
      };

      if (meta.workspaceAccess === 'none' || this.coordinator === undefined) {
        if (meta.workspaceAccess !== 'none' && this.coordinator === undefined) {
          result = errorResult(
            toolCallId,
            name,
            'execution_failed',
            'Workspace coordinator is unavailable.',
          );
          return result;
        }
        if (
          meta.workspaceAccess !== 'none' &&
          executionOptions.workspaceId === undefined
        ) {
          result = errorResult(
            toolCallId,
            name,
            'execution_failed',
            'Workspace is required for this tool.',
          );
          return result;
        }
        result = await runHandler();
        return result;
      }

      if (executionOptions.workspaceId === undefined) {
        result = errorResult(
          toolCallId,
          name,
          'execution_failed',
          'Workspace is required for this tool.',
        );
        return result;
      }

      try {
        result = await this.coordinator.run({
          workspaceId: executionOptions.workspaceId,
          access: meta.workspaceAccess,
          ...(executionOptions.signal === undefined
            ? {}
            : { signal: executionOptions.signal }),
          task: runHandler,
        });
        return result;
      } catch (error) {
        if (error instanceof WorkspaceError) {
          if (error.code === 'cancelled') {
            throw new ToolExecutionError(
              'aborted',
              'Tool execution was aborted.',
            );
          }
          result = errorResult(
            toolCallId,
            name,
            'execution_failed',
            error.message,
          );
          return result;
        }
        throw error;
      }
    } catch (error) {
      if (error instanceof ToolExecutionError) {
        log('warn', 'tool.execution.cancelled', {
          code: error.code,
          durationMs: Math.max(0, performance.now() - started),
        });
        throw error;
      }
      result = errorResult(toolCallId, name, 'execution_failed');
      return result;
    } finally {
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
