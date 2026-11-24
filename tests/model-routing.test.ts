import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ModelError,
  type ModelClient,
  type ModelRequest,
  type ModelResponse,
} from '../src/harness/contracts/model/index.ts';
import {
  DefaultModelRegistry,
  ModelRouter,
  parseModelId,
} from '../src/runtime/model/index.ts';

function client(label: string, seen: ModelRequest[]): ModelClient {
  const response = (request: ModelRequest): ModelResponse => ({
    model: `${request.model}-resolved`,
    message: { role: 'assistant', content: label },
    finishReason: 'stop',
  });
  return {
    async generate(request) {
      seen.push(request);
      return response(request);
    },
    async *stream(request) {
      seen.push(request);
      yield { type: 'message_start', model: request.model };
      yield { type: 'text_delta', text: label };
      yield { type: 'message_end', response: response(request) };
    },
  };
}

const request = (model: string): ModelRequest => ({
  model,
  messages: [{ role: 'user', content: 'hello' }],
  tools: [
    {
      name: 'add',
      description: 'add',
      parameters: { type: 'object' },
    },
  ],
  parameters: { temperature: 0.2 },
});

test('Registry显式注册多个Provider/模型，只按第一个斜杠拆分并返回只读列表', () => {
  const seen: ModelRequest[] = [];
  const registry = new DefaultModelRegistry(
    new Map([
      ['alpha', client('a', seen)],
      ['custom-id', client('b', seen)],
    ]),
    ['alpha/model', 'custom-id/vendor/family/model'],
  );
  assert.deepEqual(registry.list(), [
    { id: 'alpha/model', providerId: 'alpha', modelId: 'model' },
    {
      id: 'custom-id/vendor/family/model',
      providerId: 'custom-id',
      modelId: 'vendor/family/model',
    },
  ]);
  assert.deepEqual(parseModelId('custom-id/vendor/model'), {
    id: 'custom-id/vendor/model',
    providerId: 'custom-id',
    modelId: 'vendor/model',
  });
  assert.equal(registry.has('missing/model'), false);
  assert.throws(
    () =>
      new DefaultModelRegistry(new Map([['alpha', client('a', seen)]]), [
        'alpha/model',
        'alpha/model',
      ]),
    /duplicated/,
  );
  assert.throws(
    () =>
      new DefaultModelRegistry(new Map([['alpha', client('a', seen)]]), [
        'missing/model',
      ]),
    /unknown provider/,
  );
});

test('Router的generate/stream向Provider发送上游Model ID并保留完整路由身份与选项', async () => {
  const firstSeen: ModelRequest[] = [];
  const secondSeen: ModelRequest[] = [];
  const registry = new DefaultModelRegistry(
    new Map([
      ['first', client('one', firstSeen)],
      ['second', client('two', secondSeen)],
    ]),
    ['first/vendor/model', 'second/vendor/model'],
  );
  const router = new ModelRouter(registry);
  const signal = new AbortController().signal;
  const generated = await router.generate(request('first/vendor/model'), {
    signal,
    timeoutMs: 100,
  });
  assert.equal(firstSeen[0]?.model, 'vendor/model');
  assert.deepEqual(firstSeen[0]?.tools, request('ignored').tools);
  assert.deepEqual(firstSeen[0]?.parameters, { temperature: 0.2 });
  assert.equal(generated.model, 'first/vendor/model-resolved');
  const events = [];
  for await (const event of router.stream(request('second/vendor/model'), {
    signal,
  })) {
    events.push(event);
  }
  assert.equal(secondSeen[0]?.model, 'vendor/model');
  assert.equal(events[0]?.type, 'message_start');
  assert.deepEqual(events.at(-1), {
    type: 'message_end',
    response: {
      model: 'second/vendor/model-resolved',
      message: { role: 'assistant', content: 'two' },
      finishReason: 'stop',
    },
  });
});

test('相同Provider Type的不同Provider ID使用各自实例与上游Model ID', async () => {
  const firstSeen: ModelRequest[] = [];
  const secondSeen: ModelRequest[] = [];
  const registry = new DefaultModelRegistry(
    new Map([
      ['alpha', client('a', firstSeen)],
      ['beta', client('b', secondSeen)],
    ]),
    ['alpha/shared-model', 'beta/shared-model'],
  );
  const router = new ModelRouter(registry);
  await router.generate(request('alpha/shared-model'));
  await router.generate(request('beta/shared-model'));
  assert.equal(firstSeen.length, 1);
  assert.equal(secondSeen.length, 1);
  assert.equal(firstSeen[0]?.model, 'shared-model');
  assert.equal(secondSeen[0]?.model, 'shared-model');
});

test('Router对未注册模型立即失败且不会调用任何Provider', async () => {
  const seen: ModelRequest[] = [];
  const router = new ModelRouter(
    new DefaultModelRegistry(new Map([['known', client('ok', seen)]]), [
      'known/model',
    ]),
  );
  await assert.rejects(
    router.generate(request('missing/model')),
    (error: unknown) =>
      error instanceof ModelError && error.code === 'invalid_request',
  );
  await assert.rejects(
    async () => {
      for await (const event of router.stream(request('missing/model'))) {
        void event;
      }
    },
    (error: unknown) =>
      error instanceof ModelError && error.code === 'invalid_request',
  );
  assert.equal(seen.length, 0);
});
