import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { runCli } from '../src/application/cli/index.ts';
import {
  bootstrap,
  resolveConfig,
  type EasyAgentConfig,
} from '../src/composition/index.ts';
import type {
  ModelClient,
  ModelRequest,
  ModelStreamEvent,
  ModelToolCall,
} from '../src/harness/contracts/model/index.ts';
import type { Logger } from '../src/runtime/logging/index.ts';

const quiet: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return quiet;
  },
};

async function* response(
  request: ModelRequest,
  output: string,
  calls: ModelToolCall[] = [],
): AsyncGenerator<ModelStreamEvent> {
  yield { type: 'message_start', model: request.model };
  if (output) yield { type: 'text_delta', text: output };
  for (const [index, call] of calls.entries())
    yield {
      type: 'tool_call_delta',
      index,
      id: call.id,
      name: call.name,
      argumentsDelta: call.argumentsJson,
    };
  yield {
    type: 'message_end',
    response: {
      model: request.model,
      message: {
        role: 'assistant',
        content: output || null,
        ...(calls.length ? { toolCalls: calls } : {}),
      },
      finishReason: calls.length ? 'tool_calls' : 'stop',
    },
  };
}

function scripted(client: ModelClient) {
  return {
    providerFactories: {
      'openai-compatible': () => ({ client }),
    },
  } as const;
}

function baseConfig(workspacePath: string): EasyAgentConfig {
  return resolveConfig({
    fileConfig: {
      providers: {
        fixture: {
          type: 'openai-compatible',
          baseURL: 'https://provider.invalid/v1',
        },
      },
      models: ['fixture/offline-model'],
      defaultModel: 'fixture/offline-model',
      agent: { maxModelRetries: 0 },
      workspace: { path: workspacePath, approvalTimeoutMs: 5_000 },
    },
  });
}

test('Application：Workspace 绑定、写文件审批通过与拒绝', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ea-ws-'));
  try {
    let turn = 0;
    const client: ModelClient = {
      async generate() {
        assert.fail('stream only');
      },
      stream(request: ModelRequest) {
        turn += 1;
        if (turn === 1) {
          return response(request, '', [
            {
              id: 'w1',
              name: 'write_file',
              argumentsJson: JSON.stringify({
                path: 'report.md',
                content: 'ok-from-tool',
              }),
            },
          ]);
        }
        return response(request, 'done');
      },
    };
    const app = await bootstrap(baseConfig(root), {
      ...scripted(client),
      logger: quiet,
    });
    try {
      const { sessionId } = app.service.createSession();
      assert.ok(app.service.getSessionWorkspaceId(sessionId));
      const status = app.service.getWorkspaceStatus(
        app.service.getSessionWorkspaceId(sessionId)!,
      );
      assert.equal(status.safety, 'NORMAL');
      assert.match(app.service.getTerminalShell(), /./);

      const seen: string[] = [];
      const stop = app.service.subscribeApprovals((request) => {
        if (request.status !== 'PENDING') return;
        seen.push(request.id);
        app.service.decideApproval(request.id, 'approve');
      });
      const result = await app.service.submit(sessionId, 'write report').result;
      stop();
      assert.equal(result.status, 'COMPLETED');
      assert.equal(seen.length, 1);
      assert.equal(
        await readFile(join(root, 'report.md'), 'utf8'),
        'ok-from-tool',
      );
    } finally {
      await app.dispose();
    }

    turn = 0;
    const rejectClient: ModelClient = {
      async generate() {
        assert.fail('stream only');
      },
      stream(request) {
        turn += 1;
        if (turn === 1) {
          return response(request, '', [
            {
              id: 'w2',
              name: 'write_file',
              argumentsJson: JSON.stringify({
                path: 'denied.md',
                content: 'nope',
              }),
            },
          ]);
        }
        return response(request, 'rejected');
      },
    };
    const app2 = await bootstrap(baseConfig(root), {
      ...scripted(rejectClient),
      logger: quiet,
    });
    try {
      const session = app2.service.createSession();
      app2.service.subscribeApprovals((request) => {
        if (request.status === 'PENDING') {
          app2.service.decideApproval(request.id, 'reject');
        }
      });
      const rejected = await app2.service.submit(
        session.sessionId,
        'deny write',
      ).result;
      assert.equal(rejected.status, 'COMPLETED');
      await assert.rejects(() => readFile(join(root, 'denied.md'), 'utf8'));
    } finally {
      await app2.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI：/workspace status 与审批交互可批准写文件', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ea-cli-ws-'));
  try {
    let turn = 0;
    const client: ModelClient = {
      async generate() {
        assert.fail('stream only');
      },
      stream(request) {
        turn += 1;
        if (turn === 1) {
          return response(request, '', [
            {
              id: 't1',
              name: 'write_file',
              argumentsJson: JSON.stringify({
                path: 'cli.txt',
                content: 'from-cli',
              }),
            },
          ]);
        }
        return response(request, 'cli-done');
      },
    };
    const input = new PassThrough();
    let outputText = '';
    const output = new Writable({
      write(chunk, _enc, next) {
        outputText += chunk.toString();
        next();
      },
    });
    const error = new Writable({
      write(_chunk, _enc, next) {
        next();
      },
    });
    const done = runCli(['chat'], {
      input,
      output,
      error,
      env: {},
      async loadConfig() {
        return baseConfig(root);
      },
      bootstrap: (cfg) =>
        bootstrap(cfg, { ...scripted(client), logger: quiet }),
    });
    await new Promise((r) => setImmediate(r));
    input.write('/workspace status\n');
    await new Promise((r) => setTimeout(r, 80));
    input.write('please write\n');
    for (let i = 0; i < 80 && !outputText.includes('批准?'); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.match(outputText, /批准\?/);
    input.write('y\n');
    for (let i = 0; i < 80 && !outputText.includes('[COMPLETED]'); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    input.write('/exit\n');
    input.end();
    assert.equal(await done, 0);
    assert.match(outputText, /safety=NORMAL/);
    assert.equal(await readFile(join(root, 'cli.txt'), 'utf8'), 'from-cli');
    assert.match(outputText, /cli-done/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
