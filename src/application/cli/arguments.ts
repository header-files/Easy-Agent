import type { EasyAgentConfigInput } from '../../composition/index.ts';

export interface ChatArguments {
  filePath?: string;
  overrides: EasyAgentConfigInput;
}

export class CliArgumentError extends Error {
  constructor() {
    super('命令或选项无效，请运行 easy-agent --help 查看用法。');
    this.name = 'CliArgumentError';
  }
}

export const help = `用法：easy-agent chat [选项]
      easy-agent --help
      easy-agent --version

选项：
  --config <path>              读取指定的 JSON 配置文件
  --model <provider/model>     应用默认模型（必须已在配置中注册）
  --max-model-retries <count>  模型失败后的额外重试次数
  --no-stream                 仅显示最终答案

配置优先级：CLI > 环境变量 > 配置文件 > 默认值。
环境变量：EASY_AGENT_DEFAULT_MODEL、EASY_AGENT_MAX_MODEL_RETRIES、
          EASY_AGENT_STREAM、LOG_LEVEL；Provider 字段可引用 \${ENV_NAME}。
交互命令：/model 查看或切换模型，/new 新建并切换 Session，
          /exit 退出，Ctrl+C 取消当前任务。
Session 仅保存在本次进程内存中。
`;

export function parseChatArguments(args: readonly string[]): ChatArguments {
  const result: ChatArguments = { overrides: {} };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--no-stream') {
      result.overrides.cli = { stream: false };
      continue;
    }
    if (!['--config', '--model', '--max-model-retries'].includes(flag ?? ''))
      throw new CliArgumentError();
    const value = args[++index];
    if (value === undefined || !value.trim() || value.startsWith('--'))
      throw new CliArgumentError();
    switch (flag) {
      case '--config':
        result.filePath = value;
        break;
      case '--model':
        result.overrides.defaultModel = value;
        break;
      case '--max-model-retries':
        if (!/^\d+$/.test(value)) throw new CliArgumentError();
        result.overrides.agent = { maxModelRetries: Number(value) };
        break;
    }
  }
  return result;
}
