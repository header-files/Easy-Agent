import pino, { type Logger as PinoLogger } from 'pino';
import type { LogFields, Logger, LoggerOptions, LogLevel } from './logger.ts';
import { safeFields, safeText } from './redact.ts';

const levels: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];
const reserved = new Set(['level', 'time', 'module', 'msg']);

function logLevel(value: unknown): LogLevel {
  if (typeof value !== 'string')
    throw new Error('Invalid logging level configuration.');
  const normalized = value.trim().toLowerCase();
  if (!levels.includes(normalized as LogLevel))
    throw new Error('Invalid logging level configuration.');
  return normalized as LogLevel;
}

function moduleName(value: unknown, redactValues: readonly string[]): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error('Logging module must be a non-empty string.');
  return safeText(value, redactValues);
}

function fields(
  value: LogFields | undefined,
  redactValues: readonly string[],
): Record<string, unknown> {
  if (value === undefined) return {};
  return Object.fromEntries(
    Object.entries(safeFields(value, redactValues)).filter(
      ([key]) => !reserved.has(key),
    ),
  );
}

function wrap(
  backend: PinoLogger,
  module: string,
  bindings: Record<string, unknown>,
  redactValues: readonly string[],
): Logger {
  const write = (
    level: LogLevel,
    message: string,
    values?: LogFields,
  ): void => {
    if (!backend.isLevelEnabled(level)) return;
    backend[level](
      { ...bindings, ...fields(values, redactValues), module },
      safeText(message, redactValues),
    );
  };
  return {
    debug: (message, values) => write('debug', message, values),
    info: (message, values) => write('info', message, values),
    warn: (message, values) => write('warn', message, values),
    error: (message, values) => write('error', message, values),
    child: (name, values) =>
      wrap(
        backend,
        moduleName(name, redactValues),
        { ...bindings, ...fields(values, redactValues) },
        redactValues,
      ),
  };
}

/** Create one configured backend; module children share its level and destination. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = logLevel(
    options.level ?? (options.env ?? process.env).LOG_LEVEL ?? 'info',
  );
  const redactValues = [...(options.redactValues ?? [])];
  const module = moduleName(options.module ?? 'easy-agent', redactValues);
  const backend = pino(
    {
      level,
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label.toUpperCase() }) },
      // Errors have already been serialized and redacted at the public boundary.
      serializers: { err: (value: unknown) => value },
    },
    options.destination ?? process.stderr,
  );
  return wrap(backend, module, {}, redactValues);
}
