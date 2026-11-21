/** Public logging contract; callers do not depend on a logging vendor. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(module: string, bindings?: LogFields): Logger;
}

/** A writable destination owned and managed by the caller. */
export interface LogDestination {
  write(chunk: string): void;
}

export interface LoggerOptions {
  module?: string;
  level?: LogLevel;
  env?: Readonly<Record<string, string | undefined>>;
  destination?: LogDestination;
  /** Known unlabelled secrets to remove from messages and structured values. */
  redactValues?: readonly string[];
}
