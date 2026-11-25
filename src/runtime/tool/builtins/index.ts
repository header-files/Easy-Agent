import type { DefaultToolRegistry } from '../default-tool-registry.ts';
import type {
  WorkspaceAccessCoordinator,
  WorkspaceManager,
} from '../../workspace/index.ts';
import { createFilesystemTools } from './filesystem.ts';
import { createTerminalTool } from './terminal.ts';
import {
  TerminalExecutor,
  type TerminalExecutorOptions,
} from './terminal-executor.ts';

export { createFilesystemTools } from './filesystem.ts';
export { createTerminalTool } from './terminal.ts';
export {
  TerminalExecutor,
  type TerminalExecutorOptions,
  type TerminalRunRequest,
  type TerminalRunResult,
} from './terminal-executor.ts';
export {
  MAX_LIST_DEPTH,
  MAX_LIST_ENTRIES,
  MAX_READ_BYTES,
  MAX_TERMINAL_OUTPUT_BYTES,
  MAX_WRITE_BYTES,
} from './limits.ts';

export interface RegisterBuiltinToolsOptions {
  manager: WorkspaceManager;
  coordinator: WorkspaceAccessCoordinator;
  terminal?: TerminalExecutor | TerminalExecutorOptions;
}

export function registerBuiltinTools(
  registry: DefaultToolRegistry,
  options: RegisterBuiltinToolsOptions,
): TerminalExecutor {
  const terminal =
    options.terminal instanceof TerminalExecutor
      ? options.terminal
      : new TerminalExecutor(options.terminal ?? {});
  for (const tool of createFilesystemTools(options.manager)) {
    registry.register(tool.spec, tool.handler, tool.meta);
  }
  const term = createTerminalTool(
    options.manager,
    options.coordinator,
    terminal,
  );
  registry.register(term.spec, term.handler, term.meta);
  return terminal;
}
