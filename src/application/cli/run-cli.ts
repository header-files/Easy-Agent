import { readFile } from 'node:fs/promises';
import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import {
  bootstrap,
  BootstrapError,
  loadConfig,
  ConfigurationError,
  type EasyAgentApplication,
  type EasyAgentConfig,
  type LoadConfigOptions,
} from '../../composition/index.ts';
import { AgentApplicationError } from '../agent-application-service.ts';
import type { SessionExecution } from '../../harness/contracts/agent/index.ts';
import { CliArgumentError, help, parseChatArguments } from './arguments.ts';
import {
  renderExecution,
  subscribeApprovalPrompts,
} from './render-execution.ts';

export interface CliSignalSource {
  on(event: 'SIGINT', listener: () => void): unknown;
  off(event: 'SIGINT', listener: () => void): unknown;
}

export interface RunCliOptions {
  input?: Readable;
  output?: Writable;
  error?: Writable;
  env?: Readonly<Record<string, string | undefined>>;
  signals?: CliSignalSource;
  bootstrap?: (config: EasyAgentConfig) => Promise<EasyAgentApplication>;
  loadConfig?: (options: LoadConfigOptions) => Promise<EasyAgentConfig>;
  version?: string;
}

function reportFailure(error: unknown, destination: Writable): void {
  if (error instanceof CliArgumentError)
    destination.write(`${error.message}\n`);
  else if (error instanceof ConfigurationError)
    destination.write(`配置错误：${error.message}\n`);
  else if (error instanceof BootstrapError) {
    destination.write(
      error.code === 'initialization_failed'
        ? `应用初始化失败（阶段：${error.stage}）。请检查配置中的模型、workspace.path 与运行环境。\n`
        : '应用清理失败。\n',
    );
  } else if (error instanceof AgentApplicationError) {
    const messages = {
      invalid_input: '输入或会话选项无效。',
      session_not_found: '找不到指定的 Session。',
      operation_failed: '应用操作失败，请重试。',
      application_disposed: '应用正在关闭。',
    };
    destination.write(`${messages[error.code]}\n`);
  } else destination.write('应用操作失败，请检查配置和运行环境。\n');
}

function createBoundSession(
  service: EasyAgentApplication['service'],
  workspaceId: string | undefined,
  allowedNames: string[] | undefined,
): string {
  return service.createSession({
    ...(workspaceId === undefined ? {} : { workspaceId }),
    ...(allowedNames === undefined
      ? {}
      : { config: { tools: { allowedNames } } }),
  }).sessionId;
}

async function handleWorkspace(
  service: EasyAgentApplication['service'],
  state: {
    sessionId: string;
    workspaceId: string | undefined;
    allowedNames: string[] | undefined;
  },
  command: string,
  output: Writable,
  error: Writable,
): Promise<void> {
  const parts = command.trim().split(/\s+/);
  const action = parts[1] ?? 'status';
  try {
    if (action === 'status') {
      const id = parts[2] ?? service.getSessionWorkspaceId(state.sessionId);
      if (!id) {
        error.write('当前 Session 未绑定 Workspace。\n');
        return;
      }
      const status = service.getWorkspaceStatus(id);
      output.write(
        `${status.name} ${status.id} safety=${status.safety} refs=${status.sessionRefs} root=${status.rootPath}\n`,
      );
      return;
    }
    if (action === 'list') {
      const list = service.listWorkspaces();
      if (list.length === 0) {
        output.write('(no workspaces)\n');
        return;
      }
      for (const item of list) {
        const mark =
          item.id === service.getSessionWorkspaceId(state.sessionId)
            ? '* '
            : '  ';
        output.write(`${mark}${item.name}\t${item.id}\t${item.rootPath}\n`);
      }
      return;
    }
    if (action === 'register') {
      const name = parts[2];
      const path = parts.slice(3).join(' ');
      if (!name || !path) {
        error.write('用法：/workspace register <name> <existing-path>\n');
        return;
      }
      const ws = await service.registerWorkspace(name, path);
      output.write(`[已注册 Workspace ${ws.name} ${ws.id}]\n`);
      return;
    }
    if (action === 'create') {
      const name = parts[2];
      const path = parts.slice(3).join(' ');
      if (!name || !path) {
        error.write('用法：/workspace create <name> <new-path>\n');
        return;
      }
      const ws = await service.createWorkspace(name, path);
      output.write(`[已创建 Workspace ${ws.name} ${ws.id}]\n`);
      return;
    }
    if (action === 'use') {
      const id = parts[2];
      if (!id) {
        error.write('用法：/workspace use <id>\n');
        return;
      }
      service.getWorkspaceStatus(id);
      state.workspaceId = id;
      state.sessionId = createBoundSession(
        service,
        state.workspaceId,
        state.allowedNames,
      );
      output.write(`[已切换至绑定 Workspace ${id} 的新 Session]\n`);
      return;
    }
    if (action === 'recover') {
      const id = parts[2] ?? service.getSessionWorkspaceId(state.sessionId);
      if (!id) {
        error.write('需要 Workspace ID。\n');
        return;
      }
      if (parts[3] !== 'confirm') {
        error.write('请使用 /workspace recover [id] confirm\n');
        return;
      }
      service.recoverWorkspace(id);
      output.write(`[Workspace ${id} recovered]\n`);
      return;
    }
    error.write(
      '用法：/workspace status|list|register|create|use|recover [id] confirm\n',
    );
  } catch (cause) {
    reportFailure(cause, error);
  }
}

async function packageVersion(): Promise<string> {
  const data: unknown = JSON.parse(
    await readFile(new URL('../../../package.json', import.meta.url), 'utf8'),
  );
  if (
    typeof data !== 'object' ||
    data === null ||
    !('version' in data) ||
    typeof data.version !== 'string'
  )
    throw new Error('Version metadata unavailable.');
  return data.version;
}

/** Local protocol adapter. Bootstrap is the sole entry to underlying components. */
export async function runCli(
  args: readonly string[] = process.argv.slice(2),
  options: RunCliOptions = {},
): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const error = options.error ?? process.stderr;
  const signals = options.signals ?? process;
  let application: EasyAgentApplication | undefined;
  let lines: Interface | undefined;
  let active: { sessionId: string; execution: SessionExecution } | undefined;
  let cancelRequested = false;
  let exiting = false;
  let exitCode = 0;
  const interrupt = () => {
    if (active) {
      if (cancelRequested) return;
      cancelRequested = true;
      try {
        if (
          application?.service.cancel(
            active.sessionId,
            active.execution.executionId,
          )
        )
          error.write('取消请求已发送，正在等待任务收尾。\n');
      } catch (cause) {
        reportFailure(cause, error);
      }
    } else {
      exiting = true;
      lines?.close();
    }
  };
  let listening = false;
  try {
    if (args.length === 0 || args.includes('--help')) {
      output.write(help);
      return 0;
    }
    if (args.length === 1 && args[0] === '--version') {
      output.write(
        `easy-agent ${options.version ?? (await packageVersion())}\n`,
      );
      return 0;
    }
    if (args[0] !== 'chat') throw new CliArgumentError();
    const parsed = parseChatArguments(args.slice(1));
    signals.on('SIGINT', interrupt);
    listening = true;
    const config = await (options.loadConfig ?? loadConfig)({
      ...parsed,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    if (exiting) return 0;
    application = await (options.bootstrap ?? bootstrap)(config);
    if (!exiting) {
      const state: {
        sessionId: string;
        workspaceId: string | undefined;
        allowedNames: string[] | undefined;
      } = {
        sessionId: '',
        workspaceId: undefined,
        allowedNames: undefined,
      };
      state.sessionId = application.service.createSession().sessionId;
      state.workspaceId = application.service.getSessionWorkspaceId(
        state.sessionId,
      );
      output.write(
        `Easy Agent — OS=${process.platform} shell=${application.service.getTerminalShell()}\n`,
      );
      output.write(
        '命令：/model、/workspace、/tools、/new、/exit；Ctrl+C 取消当前任务。\n',
      );
      if (!state.workspaceId) {
        output.write(
          '提示：未配置默认 Workspace。可用 /workspace register|create 后 /workspace use <id>。\n',
        );
      }
      const terminal = Boolean(
        'isTTY' in input && input.isTTY && 'isTTY' in output && output.isTTY,
      );
      lines = createInterface({ input, output, terminal });
      lines.on('SIGINT', interrupt);
      const iterator = lines[Symbol.asyncIterator]();
      while (!exiting) {
        if (terminal) output.write('> ');
        const next = await iterator.next();
        if (next.done || exiting) break;
        const line = next.value;
        const command = line.trim();
        if (!command) continue;
        if (command === '/exit') break;
        if (command === '/new' || command.startsWith('/new ')) {
          const id = command === '/new' ? undefined : command.slice(5).trim();
          if (id) {
            try {
              application.service.getWorkspaceStatus(id);
              state.workspaceId = id;
            } catch {
              error.write('Workspace 不存在，Session 未创建。\n');
              continue;
            }
          }
          state.sessionId = createBoundSession(
            application.service,
            state.workspaceId,
            state.allowedNames,
          );
          output.write(
            `[已切换至新 Session${state.workspaceId ? ` workspace=${state.workspaceId}` : ''}]\n`,
          );
          continue;
        }
        if (command === '/model') {
          const current = application.service.getSessionModel(state.sessionId);
          output.write(
            `${application.service
              .listModels()
              .map(
                (model) => `${model.id === current ? '* ' : '  '}${model.id}`,
              )
              .join('\n')}\n`,
          );
          continue;
        }
        if (command.startsWith('/model ')) {
          const modelId = command.slice('/model '.length).trim();
          try {
            application.service.setSessionModel(state.sessionId, modelId);
            output.write(`[当前模型：${modelId}]\n`);
          } catch {
            error.write('模型未注册或标识无效，当前 Session 模型未改变。\n');
          }
          continue;
        }
        if (command === '/tools') {
          output.write(
            state.allowedNames === undefined
              ? '[工具] 使用全部已注册工具（下一次 /new 生效）\n'
              : `[工具] allowedNames=${state.allowedNames.join(',')}\n`,
          );
          continue;
        }
        if (command.startsWith('/tools ')) {
          const raw = command.slice('/tools '.length).trim();
          if (raw === '*' || raw === 'all') {
            state.allowedNames = undefined;
            output.write('[工具] 已清除限制；/new 后使用全部已注册工具。\n');
          } else {
            state.allowedNames = raw
              .split(',')
              .map((name) => name.trim())
              .filter(Boolean);
            output.write(
              `[工具] 下次 /new 将使用：${state.allowedNames.join(', ')}\n`,
            );
          }
          continue;
        }
        if (command === '/workspace' || command.startsWith('/workspace ')) {
          await handleWorkspace(
            application.service,
            state,
            command,
            output,
            error,
          );
          continue;
        }
        if (command.startsWith('/')) {
          error.write(
            '未知交互命令。可使用 /model、/workspace、/tools、/new 或 /exit。\n',
          );
          continue;
        }
        try {
          const ask = async (question: string) => {
            output.write(question);
            const answer = await iterator.next();
            return answer.done ? '' : String(answer.value);
          };
          // Open the approval channel before submit to avoid fail-closed races.
          const stopApprovals = subscribeApprovalPrompts(
            application.service,
            output,
            error,
            ask,
          );
          try {
            const execution = application.service.submit(state.sessionId, line);
            active = { sessionId: state.sessionId, execution };
            cancelRequested = false;
            const status = await renderExecution(
              execution,
              output,
              error,
              config.cli.stream,
              {
                service: application.service,
                ask,
                approvalSubscriptionActive: true,
              },
            );
            if (status === 'FAILED' || status === 'ERROR') exitCode = 1;
          } finally {
            stopApprovals();
          }
        } catch (cause) {
          reportFailure(cause, error);
          exitCode = 1;
        } finally {
          active = undefined;
        }
      }
    }
  } catch (cause) {
    reportFailure(cause, error);
    exitCode = 1;
  } finally {
    lines?.off('SIGINT', interrupt);
    lines?.close();
    if (listening) signals.off('SIGINT', interrupt);
    if (application) {
      try {
        await application.dispose();
      } catch {
        error.write('应用资源清理失败。\n');
        exitCode = 1;
      }
    }
  }
  return exitCode;
}
