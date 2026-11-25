import {
  ModelError,
  type ModelClient,
  type ModelResponse,
} from '../../harness/contracts/model/index.ts';
import type {
  AgentLoop,
  AgentLoopContext,
  AgentLoopEvent,
  AgentLoopResult,
} from '../../harness/contracts/agent-loop/index.ts';
import type {
  ToolExecutor,
  ToolRegistry,
} from '../../harness/contracts/tool/index.ts';
import { toToolResultMessage } from '../../runtime/tool/model-bridge.ts';
import { prepare } from './prepare.ts';
import { controlledRun, type LoopControl } from './control.ts';
import {
  copyData,
  copyEvent,
  copyMessage,
  copyResponse,
  copyToolResult,
  invalidResponse,
} from './snapshots.ts';

interface Counts {
  modelCalls: number;
  modelRetries: number;
  toolCalls: number;
}
/** Default policy only: reusable capabilities are supplied by the caller. */
export class DefaultAgentLoop implements AgentLoop {
  private readonly modelClient: ModelClient;
  private readonly toolRegistry: ToolRegistry;
  private readonly toolExecutor: ToolExecutor;

  constructor(
    modelClient: ModelClient,
    toolRegistry: ToolRegistry,
    toolExecutor: ToolExecutor,
  ) {
    this.modelClient = modelClient;
    this.toolRegistry = toolRegistry;
    this.toolExecutor = toolExecutor;
  }

  run(context: AgentLoopContext): AsyncIterable<AgentLoopEvent> {
    return controlledRun(context, (control) => this.execute(context, control));
  }

  private async *execute(
    context: AgentLoopContext,
    control: LoopControl,
  ): AsyncGenerator<AgentLoopEvent> {
    try {
      control.check();
      const prepared = {
        ...prepare(context, this.toolRegistry),
        signal: control.signal,
      };
      control.check();
      const counts: Counts = { modelCalls: 0, modelRetries: 0, toolCalls: 0 };
      let modelCallIndex = 0;
      yield { type: 'loop_start' };
      while (true) {
        control.check();
        modelCallIndex++;
        const response = yield* this.modelRound(
          prepared,
          modelCallIndex,
          counts,
          control,
        );
        const calls = response.message.toolCalls ?? [];
        if (response.finishReason === 'stop' && calls.length === 0) {
          prepared.messages.push(copyMessage(response.message));
          control.finish();
          yield {
            type: 'loop_end',
            result: this.result(prepared, counts, {
              status: 'completed',
              output: response.message.content ?? '',
            }),
          };
          return;
        }
        if (
          ['length', 'content_filter', 'other'].includes(response.finishReason)
        ) {
          control.finish();
          yield {
            type: 'loop_end',
            result: this.result(prepared, counts, {
              status: 'stopped',
              reason: response.finishReason,
              output: response.message.content ?? '',
            }),
          };
          return;
        }
        if (response.finishReason !== 'tool_calls' || calls.length === 0)
          return invalidResponse();
        if (calls.some((call) => !prepared.allowedNames.has(call.name)))
          throw new Error('Model requested a tool outside the allowed scope.');
        prepared.messages.push(copyMessage(response.message));
        for (const call of calls) {
          control.check();
          control.setPhase('tool');
          yield { type: 'tool_start', modelCallIndex, call: { ...call } };
          control.check();
          counts.toolCalls++;
          const value = await control.wait(() =>
            this.toolExecutor.execute(
              { ...call },
              {
                signal: prepared.signal,
                ...(prepared.options.toolTimeoutMs === undefined
                  ? {}
                  : { timeoutMs: prepared.options.toolTimeoutMs }),
                ...(context.metadata?.workspaceId === undefined
                  ? {}
                  : { workspaceId: context.metadata.workspaceId }),
                ...(context.metadata?.sessionId === undefined
                  ? {}
                  : { sessionId: context.metadata.sessionId }),
                ...(context.metadata?.executionId === undefined
                  ? {}
                  : { executionId: context.metadata.executionId }),
              },
            ),
          );
          control.check();
          const result = copyToolResult(value, call);
          prepared.messages.push(toToolResultMessage(result));
          yield {
            type: 'tool_result',
            modelCallIndex,
            result: copyToolResult(result, call),
          };
        }
      }
    } finally {
      control.dispose();
    }
  }

  private result(
    prepared: ReturnType<typeof prepare>,
    counts: Counts,
    result: AgentLoopResult,
  ): AgentLoopResult {
    return {
      ...result,
      updatedContext: {
        messages: prepared.messages.map((message) => copyMessage(message)),
        ...(prepared.data === undefined ? {} : { data: prepared.data }),
      },
      details: { ...counts },
    };
  }

  private async *modelRound(
    prepared: ReturnType<typeof prepare>,
    modelCallIndex: number,
    counts: Counts,
    control: LoopControl,
  ): AsyncGenerator<AgentLoopEvent, ModelResponse> {
    for (let retry = 0; ; retry++) {
      control.setPhase('model');
      control.check();
      let exposed = false;
      let started = false;
      let response: ModelResponse | undefined;
      counts.modelCalls++;
      try {
        const request = {
          model: prepared.model,
          messages: prepared.messages.map((message) => {
            const snapshot = copyMessage(message);
            return snapshot.role === 'assistant' &&
              snapshot.content === null &&
              !snapshot.toolCalls?.length
              ? { ...snapshot, content: '' }
              : snapshot;
          }),
          tools: prepared.definitions.map((tool) => ({
            ...tool,
            parameters: copyData(tool.parameters) as Record<string, unknown>,
          })),
          ...(prepared.parameters === undefined
            ? {}
            : {
                parameters: copyData(
                  prepared.parameters,
                ) as typeof prepared.parameters,
              }),
        };
        const iterable = this.modelClient.stream(request, {
          signal: prepared.signal,
          ...(prepared.options.modelTimeoutMs === undefined
            ? {}
            : { timeoutMs: prepared.options.modelTimeoutMs }),
        });
        if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function')
          return invalidResponse();
        const iterator = iterable[Symbol.asyncIterator]();
        if (!iterator || typeof iterator.next !== 'function')
          return invalidResponse();
        let done = false;
        try {
          while (true) {
            const step = await control.wait(() => iterator.next());
            if (
              !step ||
              typeof step !== 'object' ||
              (step.done !== undefined && typeof step.done !== 'boolean')
            )
              return invalidResponse();
            if (step.done) {
              done = true;
              break;
            }
            const value = step.value;
            control.check();
            const event = copyEvent(value);
            if (
              response ||
              (!started && event.type !== 'message_start') ||
              (started && event.type === 'message_start')
            )
              return invalidResponse();
            if (event.type === 'message_start') started = true;
            if (event.type === 'message_end')
              response = copyResponse(event.response);
            exposed = true;
            yield {
              type: 'model_event',
              modelCallIndex,
              event: copyEvent(event),
            };
            if (event.type === 'text_delta')
              yield { type: 'output_delta', content: event.text };
          }
        } finally {
          if (!done) {
            try {
              const close = iterator.return;
              if (close) {
                const cleanup = Promise.resolve(close.call(iterator));
                void cleanup.catch(() => {});
                // Exceptional/early exit never waits indefinitely for a noncooperative finalizer.
                // Normal stream completion is confirmed separately by awaiting iterator EOF.
              }
            } catch {
              // Cleanup is best effort: it cannot replace the attempt outcome or create a retry source.
            }
          }
        }
        if (!started || !response) return invalidResponse();
        return response;
      } catch (error) {
        control.check();
        if (
          !(error instanceof ModelError) ||
          error.code === 'aborted' ||
          !error.retryable ||
          exposed ||
          retry >= prepared.options.maxModelRetries
        )
          throw error;
        counts.modelRetries++;
      }
    }
  }
}
