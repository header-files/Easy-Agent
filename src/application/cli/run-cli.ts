import { readFile } from 'node:fs/promises';
import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import {
  bootstrap,
  loadConfig,
  ConfigurationError,
  type EasyAgentApplication,
  type EasyAgentConfig,
  type LoadConfigOptions,
} from '../../composition/index.ts';
import { AgentApplicationError } from '../agent-application-service.ts';
import type { SessionExecution } from '../../harness/contracts/agent/index.ts';
import { CliArgumentError, help, parseChatArguments } from './arguments.ts';
import { renderExecution } from './render-execution.ts';

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
  else if (error instanceof AgentApplicationError) {
    const messages = {
      invalid_input: '输入或会话选项无效。',
      session_not_found: '找不到指定的 Session。',
      operation_failed: '应用操作失败，请重试。',
      application_disposed: '应用正在关闭。',
    };
    destination.write(`${messages[error.code]}\n`);
  } else destination.write('应用操作失败，请检查配置和运行环境。\n');
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
      let sessionId = application.service.createSession().sessionId;
      output.write(
        'Easy Agent — /new 新会话，/exit 退出，Ctrl+C 取消当前任务。\n',
      );
      const terminal = Boolean(
        'isTTY' in input && input.isTTY && 'isTTY' in output && output.isTTY,
      );
      lines = createInterface({ input, output, terminal });
      lines.on('SIGINT', interrupt);
      // Create the iterator immediately so piped lines/EOF are retained while
      // execution is running. This is input buffering, not a second task queue.
      const iterator = lines[Symbol.asyncIterator]();
      while (!exiting) {
        if (terminal) output.write('> ');
        const next = await iterator.next();
        if (next.done || exiting) break;
        const line = next.value;
        const command = line.trim();
        if (!command) continue;
        if (command === '/exit') break;
        if (command === '/new') {
          sessionId = application.service.createSession().sessionId;
          output.write('[已切换至新 Session]\n');
          continue;
        }
        if (command.startsWith('/')) {
          error.write('未知交互命令。可使用 /new 或 /exit。\n');
          continue;
        }
        try {
          const execution = application.service.submit(sessionId, line);
          active = { sessionId, execution };
          cancelRequested = false;
          const status = await renderExecution(
            execution,
            output,
            error,
            config.cli.stream,
          );
          if (status === 'FAILED' || status === 'ERROR') exitCode = 1;
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
