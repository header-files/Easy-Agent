import type {
  ToolHandler,
  ToolSpec,
} from '../../../harness/contracts/tool/index.ts';
import {
  WorkspaceError,
  WorkspacePathResolver,
  type WorkspaceAccessCoordinator,
  type WorkspaceManager,
} from '../../workspace/index.ts';
import type { ToolRuntimeMeta } from '../tool-meta.ts';
import type { BuiltinTool } from './filesystem.ts';
import { TerminalExecutor } from './terminal-executor.ts';

export function createTerminalTool(
  manager: WorkspaceManager,
  coordinator: WorkspaceAccessCoordinator,
  executor: TerminalExecutor = new TerminalExecutor(),
): BuiltinTool {
  const spec: ToolSpec = {
    name: 'terminal',
    description:
      'Run a shell command string in the workspace root. Not a filesystem sandbox; approved commands may still access outside paths/network.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: 2_147_483_647,
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  };
  const meta: ToolRuntimeMeta = {
    approval: 'always',
    workspaceAccess: 'write',
  };
  const handler: ToolHandler = async (args, context) => {
    if (!context.workspaceId) throw new WorkspaceError('invalid_request');
    const workspace = manager.get(context.workspaceId);
    if (!workspace) throw new WorkspaceError('not_found');
    const resolver = new WorkspacePathResolver(workspace.rootPath);
    const cwd = await resolver.resolve('.');
    const timeoutMs =
      typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
    try {
      const result = await executor.run({
        command: String(args.command),
        cwd: cwd.absolute,
        ...(context.signal === undefined ? {} : { signal: context.signal }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        onCleanupUncertain: () => {
          coordinator.markUnsafe(workspace.id);
        },
      });
      return {
        content: JSON.stringify(
          {
            exitCode: result.exitCode,
            signal: result.signal,
            stdout: result.stdout,
            stderr: result.stderr,
            truncated: result.truncated,
            timedOut: result.timedOut,
            cancelled: result.cancelled,
            shell: executor.getShell(),
            cwd: cwd.relative,
          },
          null,
          2,
        ),
      };
    } catch (error) {
      if (error instanceof WorkspaceError && error.code === 'unsafe') {
        coordinator.markUnsafe(workspace.id);
      }
      throw error;
    }
  };
  return { spec, handler, meta };
}
