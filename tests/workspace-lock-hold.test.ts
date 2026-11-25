import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ToolExecutionError } from '../src/harness/contracts/tool/index.ts';
import { ApprovalService } from '../src/runtime/approval/index.ts';
import {
  DefaultToolRegistry,
  GuardedToolExecutor,
} from '../src/runtime/tool/index.ts';
import { WorkspaceAccessCoordinator } from '../src/runtime/workspace/index.ts';

test('工具超时后仍持锁直至 Handler 结束，随后读才能进入', async () => {
  const registry = new DefaultToolRegistry();
  let releaseHandler!: () => void;
  const handlerGate = new Promise<void>((resolve) => {
    releaseHandler = resolve;
  });
  let handlerFinished = false;
  let readerStartedWhileWriterAlive = false;
  registry.register(
    {
      name: 'slow_write',
      description: 'holds until released',
      parameters: { type: 'object', additionalProperties: false },
    },
    async (_args, context) => {
      await Promise.race([
        handlerGate,
        new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        }),
      ]);
      // Simulate cleanup that continues after abort while lock must stay held.
      await new Promise((resolve) => setTimeout(resolve, 120));
      handlerFinished = true;
      return { content: 'done' };
    },
    { approval: 'never', workspaceAccess: 'write' },
  );
  registry.register(
    {
      name: 'quick_read',
      description: 'read',
      parameters: { type: 'object', additionalProperties: false },
    },
    () => {
      if (!handlerFinished) readerStartedWhileWriterAlive = true;
      return { content: 'read' };
    },
    { approval: 'never', workspaceAccess: 'read' },
  );

  const coordinator = new WorkspaceAccessCoordinator();
  const executor = new GuardedToolExecutor(registry, {
    approval: new ApprovalService(),
    coordinator,
  });

  const writer = executor.execute(
    { id: 'w1', name: 'slow_write', argumentsJson: '{}' },
    { executionId: 'e1', workspaceId: 'ws', timeoutMs: 20 },
  );
  const writerOutcome = writer.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  await new Promise((resolve) => setTimeout(resolve, 40));
  const readerPromise = executor.execute(
    { id: 'r1', name: 'quick_read', argumentsJson: '{}' },
    { executionId: 'e2', workspaceId: 'ws' },
  );

  await new Promise((resolve) => setTimeout(resolve, 20));
  // Reader must still be blocked: writer handler not finished / lock held.
  assert.equal(readerStartedWhileWriterAlive, false);
  assert.equal(handlerFinished, false);

  releaseHandler();
  const outcome = await writerOutcome;
  assert.equal(outcome.ok, false);
  assert.ok(
    outcome.error instanceof ToolExecutionError &&
      outcome.error.code === 'timeout',
  );
  assert.equal(handlerFinished, true);
  assert.equal((await readerPromise).content, 'read');
  assert.equal(readerStartedWhileWriterAlive, false);
});

test('Handler 在宽限后仍未结束时标记 UNSAFE 再放锁', async () => {
  const registry = new DefaultToolRegistry();
  registry.register(
    {
      name: 'stuck',
      description: 'ignores abort',
      parameters: { type: 'object', additionalProperties: false },
    },
    () =>
      new Promise(() => {
        /* never settles */
      }),
    { approval: 'never', workspaceAccess: 'write' },
  );
  const coordinator = new WorkspaceAccessCoordinator();
  const executor = new GuardedToolExecutor(registry, {
    approval: new ApprovalService(),
    coordinator,
    handlerSettleGraceMs: 50,
  });
  const writer = executor.execute(
    { id: 's1', name: 'stuck', argumentsJson: '{}' },
    { executionId: 'e1', workspaceId: 'ws', timeoutMs: 10 },
  );
  await assert.rejects(
    writer,
    (error: unknown) =>
      error instanceof ToolExecutionError && error.code === 'timeout',
  );
  assert.equal(coordinator.safety('ws'), 'UNSAFE');
});
