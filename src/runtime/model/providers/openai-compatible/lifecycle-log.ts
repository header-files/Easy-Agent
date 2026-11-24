import { randomUUID } from 'node:crypto';
import {
  ModelError,
  type ModelResponse,
} from '../../../../harness/contracts/model/index.ts';
import {
  createLogger,
  type Logger,
  type LogFields,
  type LogLevel,
} from '../../../logging/index.ts';
import { safeFields } from '../../../logging/redact.ts';

const defaultModule = 'runtime.model.openai-compatible';

/** A broken diagnostic backend must never determine a model request's result. */
export function clientLogger(
  logger: Logger | undefined,
  apiKey: string | undefined,
  module = defaultModule,
): Logger | undefined {
  try {
    return logger === undefined
      ? createLogger({ module, redactValues: apiKey ? [apiKey] : [] })
      : logger.child(module);
  } catch {
    return undefined;
  }
}

/** One local correlation id and one terminal event for each consumed call. */
export class LifecycleLog {
  private readonly requestId = randomUUID();
  private readonly startedAt = performance.now();
  private readonly logger: Logger | undefined;
  private readonly operation: 'generate' | 'stream';
  private readonly redactValues: readonly string[];
  private model: string | undefined;
  private terminal = false;

  constructor(
    logger: Logger | undefined,
    operation: 'generate' | 'stream',
    request: unknown,
    redactValues: readonly string[],
  ) {
    this.logger = logger;
    this.operation = operation;
    this.redactValues = redactValues;
    // Do not execute a caller's model getter just to emit diagnostic metadata.
    try {
      const descriptor =
        typeof request === 'object' && request !== null
          ? Object.getOwnPropertyDescriptor(request, 'model')
          : undefined;
      if (
        descriptor &&
        'value' in descriptor &&
        typeof descriptor.value === 'string'
      )
        this.model = descriptor.value;
    } catch {
      /* Validation remains the request mapper's responsibility. */
    }
    this.write('debug', 'started', 'Model request started');
  }

  setModel(model: string): void {
    this.model = model;
  }

  private write(
    level: LogLevel,
    event: 'started' | 'completed' | 'cancelled' | 'failed',
    message: string,
    fields: LogFields = {},
  ): void {
    try {
      const outcome: unknown = this.logger?.[level](
        message,
        safeFields(
          {
            event: `model.request.${event}`,
            requestId: this.requestId,
            operation: this.operation,
            ...(this.model === undefined ? {} : { model: this.model }),
            ...fields,
          },
          this.redactValues,
        ),
      );
      // Async functions may satisfy a void method; observe rejection without awaiting diagnostics.
      if (outcome !== undefined) void Promise.resolve(outcome).catch(() => {});
    } catch {
      /* Logging is best effort, including user-provided Logger methods. */
    }
  }

  private duration(): number {
    return Math.max(
      0,
      Math.round((performance.now() - this.startedAt) * 1000) / 1000,
    );
  }

  completed(response: ModelResponse): void {
    if (this.terminal) return;
    this.terminal = true;
    this.write('info', 'completed', 'Model request completed', {
      durationMs: this.duration(),
      finishReason: response.finishReason,
      ...(response.usage === undefined ? {} : { usage: response.usage }),
    });
  }

  failed(error: ModelError): void {
    if (this.terminal) return;
    this.terminal = true;
    if (error.code === 'aborted' || error.code === 'timeout') {
      this.write('warn', 'cancelled', 'Model request cancelled', {
        durationMs: this.duration(),
        code: error.code,
      });
      return;
    }
    // Rebuild instead of forwarding any error message, cause or stack supplied by a transport.
    const err = new ModelError({
      code: error.code,
      retryable: error.retryable,
      message: 'Model request failed.',
      ...(error.status === undefined ? {} : { status: error.status }),
    });
    this.write('error', 'failed', 'Model request failed', {
      durationMs: this.duration(),
      code: error.code,
      retryable: error.retryable,
      ...(error.status === undefined ? {} : { status: error.status }),
      err,
    });
  }

  returned(): void {
    if (this.terminal) return;
    this.terminal = true;
    this.write('warn', 'cancelled', 'Model request cancelled', {
      durationMs: this.duration(),
      code: 'consumer_return',
    });
  }
}
