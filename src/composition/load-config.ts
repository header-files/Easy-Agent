import { readFile } from 'node:fs/promises';
import {
  ConfigurationError,
  resolveConfig,
  type EasyAgentConfig,
  type EasyAgentConfigInput,
} from './config.ts';

export interface LoadConfigOptions {
  filePath?: string;
  env?: Readonly<Record<string, string | undefined>>;
  overrides?: EasyAgentConfigInput;
}

/** Only an explicitly requested JSON file is read; this does not load .env files. */
export async function loadConfig(
  options: LoadConfigOptions = {},
): Promise<EasyAgentConfig> {
  let fileConfig: unknown;
  if (options.filePath !== undefined) {
    try {
      fileConfig = JSON.parse(
        await readFile(options.filePath, 'utf8'),
      ) as unknown;
    } catch {
      throw new ConfigurationError(
        'Configuration file could not be read as JSON.',
      );
    }
  }
  return resolveConfig({
    fileConfig,
    env: options.env ?? process.env,
    ...(options.overrides === undefined
      ? {}
      : { overrides: options.overrides }),
  });
}
