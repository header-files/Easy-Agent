import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ModelError,
  type ModelRequest,
  type ModelStreamEvent,
} from '../src/harness/contracts/model/index.ts';
import { OpenAIResponsesModelClient } from '../src/runtime/model/index.ts';

const request: ModelRequest = {
  model: 'gpt-4.1-mini',
  messages: [{ role: 'user', content: 'hello' }],
};

const completed = (extra: Record<string, unknown> = {}) => ({
  id: 'resp_1',
  model: 'gpt-4.1-mini',
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hi' }],
    },
  ],
  usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
  ...extra,
});

const client = (result: unknown, status = 200) =>
  new OpenAIResponsesModelClient({
    baseURL: 'https://provider.invalid/v1',
    apiKey: 'test-key',
    fetch: async () => new Response(JSON.stringify(result), { status }),
  });

const code = (expected: string) => (error: unknown) =>
  error instanceof ModelError && error.code === expected;

const collect = async (
  events: AsyncIterable<ModelStreamEvent>,
): Promise<ModelStreamEvent[]> => {
  const result: ModelStreamEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
};

const streamClient = (frames: unknown[]) =>
  new OpenAIResponsesModelClient({
    baseURL: 'https://provider.invalid/v1',
    apiKey: 'test-key',
    fetch: async () =>
      new Response(
        frames
          .map(
            (frame) =>
              `data: ${typeof frame === 'string' ? frame : JSON.stringify(frame)}\n\n`,
          )
          .join(''),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });

function recording() {
  const sent: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const headers: Headers[] = [];
  const instance = new OpenAIResponsesModelClient({
    apiKey: 'test-key',
    baseURL: 'https://provider.invalid/v1/',
    fetch: async (url, init) => {
      urls.push(String(url));
      headers.push(new Headers(init?.headers));
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(completed()));
    },
  });
  return { instance, sent, urls, headers };
}

test('Responses非流式文本、用量与请求历史/工具schema映射', async () => {
  const { instance, sent, urls, headers } = recording();
  const response = await instance.generate({
    model: 'gpt-4.1-mini',
    messages: [
      { role: 'system', content: 'system' },
      { role: 'user', content: 'user' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'call_1', name: 'add', argumentsJson: '{"a":1}' }],
      },
      {
        role: 'tool',
        toolCallId: 'call_1',
        content: '2',
        isError: false,
      },
    ],
    tools: [
      {
        name: 'add',
        description: 'add numbers',
        parameters: { type: 'object' },
      },
    ],
    toolChoice: 'auto',
    parameters: { temperature: 0.2, maxOutputTokens: 16 },
  });
  assert.equal(urls[0], 'https://provider.invalid/v1/responses');
  assert.equal(headers[0]?.get('authorization'), 'Bearer test-key');
  assert.deepEqual(sent[0], {
    model: 'gpt-4.1-mini',
    input: [
      { type: 'message', role: 'system', content: 'system' },
      { type: 'message', role: 'user', content: 'user' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'add',
        arguments: '{"a":1}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: '2' },
    ],
    stream: false,
    tools: [
      {
        type: 'function',
        name: 'add',
        description: 'add numbers',
        parameters: { type: 'object' },
        strict: false,
      },
    ],
    tool_choice: 'auto',
    temperature: 0.2,
    max_output_tokens: 16,
  });
  assert.deepEqual(response, {
    id: 'resp_1',
    model: 'gpt-4.1-mini',
    message: { role: 'assistant', content: 'hi' },
    finishReason: 'stop',
    usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
  });
});

test('Responses非流式工具调用使用call_id，并拒绝服务端会话字段', async () => {
  const result = await client({
    id: 'resp_2',
    model: 'gpt-4.1-mini',
    status: 'completed',
    output: [
      {
        type: 'function_call',
        call_id: 'call_9',
        name: 'weather',
        arguments: '{"city":"Paris"}',
      },
    ],
  }).generate(request);
  assert.deepEqual(result.message.toolCalls, [
    {
      id: 'call_9',
      name: 'weather',
      argumentsJson: '{"city":"Paris"}',
    },
  ]);
  assert.equal(result.finishReason, 'tool_calls');
  await assert.rejects(
    client(completed()).generate({
      ...request,
      parameters: { previous_response_id: 'resp_old' },
    }),
    code('unsupported_capability'),
  );
  await assert.rejects(
    client(completed()).generate({
      ...request,
      parameters: { conversation: 'conv_1' },
    }),
    code('unsupported_capability'),
  );
});

test('Responses流式文本与function_call参数增量组装', async () => {
  const events = await collect(
    streamClient([
      {
        type: 'response.created',
        response: { id: 'resp_s', model: 'gpt-4.1-mini' },
      },
      { type: 'response.output_text.delta', delta: 'Hel' },
      { type: 'response.output_text.delta', delta: 'lo' },
      {
        type: 'response.completed',
        response: completed({
          id: 'resp_s',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Hello' }],
            },
          ],
        }),
      },
    ]).stream(request),
  );
  assert.deepEqual(events[0], {
    type: 'message_start',
    id: 'resp_s',
    model: 'gpt-4.1-mini',
  });
  assert.deepEqual(
    events.filter((event) => event.type === 'text_delta'),
    [
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
    ],
  );
  assert.equal(events.at(-1)?.type, 'message_end');

  const toolEvents = await collect(
    streamClient([
      {
        type: 'response.created',
        response: { id: 'resp_t', model: 'gpt-4.1-mini' },
      },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call_t',
          name: 'add',
          arguments: '',
        },
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '{"a":',
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        delta: '1}',
      },
      {
        type: 'response.function_call_arguments.done',
        output_index: 0,
        arguments: '{"a":1}',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          call_id: 'call_t',
          name: 'add',
          arguments: '{"a":1}',
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_t',
          model: 'gpt-4.1-mini',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              call_id: 'call_t',
              name: 'add',
              arguments: '{"a":1}',
            },
          ],
        },
      },
    ]).stream(request),
  );
  const deltas = toolEvents.filter((event) => event.type === 'tool_call_delta');
  assert.deepEqual(deltas[0], {
    type: 'tool_call_delta',
    index: 0,
    id: 'call_t',
    name: 'add',
  });
  assert.deepEqual(deltas.slice(1), [
    { type: 'tool_call_delta', index: 0, argumentsDelta: '{"a":' },
    { type: 'tool_call_delta', index: 0, argumentsDelta: '1}' },
  ]);
  const toolEnd = toolEvents.at(-1);
  assert.equal(toolEnd?.type, 'message_end');
  if (toolEnd?.type === 'message_end') {
    assert.deepEqual(toolEnd.response.message.toolCalls, [
      { id: 'call_t', name: 'add', argumentsJson: '{"a":1}' },
    ]);
  }
});

test('Responses HTTP错误、Provider错误、取消和超时保持统一语义', async () => {
  await assert.rejects(
    client({}, 401).generate(request),
    code('authentication'),
  );
  await assert.rejects(async () => {
    for await (const event of streamClient([
      { type: 'response.failed', response: { error: {} } },
    ]).stream(request)) {
      void event;
    }
  }, code('provider_error'));
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    client(completed()).generate(request, { signal: cancelled.signal }),
    code('aborted'),
  );
  await assert.rejects(
    new OpenAIResponsesModelClient({
      baseURL: 'https://provider.invalid/v1',
      apiKey: 'test-key',
      fetch: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    }).generate(request, { timeoutMs: 1 }),
    code('timeout'),
  );
});
