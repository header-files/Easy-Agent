import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ApprovalError,
  ApprovalService,
} from '../src/runtime/approval/index.ts';
import {
  DefaultToolRegistry,
  GuardedToolExecutor,
} from '../src/runtime/tool/index.ts';
import {
  WorkspaceAccessCoordinator,
  WorkspaceError,
} from '../src/runtime/workspace/index.ts';
import { ToolExecutionError } from '../src/harness/contracts/tool/index.ts';

const echoSpec = {
  name: 'echo',
  description: 'echo',
  parameters: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
};

test('always 审批：批准执行、拒绝/超时/取消不进入 Handler，迟到批准无效', async () => {
  const registry = new DefaultToolRegistry();
  let runs = 0;
  registry.register(
    echoSpec,
    (args) => {
      runs += 1;
      return { content: String(args.text) };
    },
    { approval: 'always', workspaceAccess: 'none' },
  );
  const approval = new ApprovalService();
  const executor = new GuardedToolExecutor(registry, {
    approval,
    approvalTimeoutMs: 50,
  });
  const call = {
    id: 'c1',
    name: 'echo',
    argumentsJson: '{"text":"hi"}',
  };

  const pending: string[] = [];
  approval.subscribe((request) => {
    if (request.status === 'PENDING') pending.push(request.id);
  });
  const approved = executor.execute(call, { executionId: 'e1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.length, 1);
  approval.decide(pending[0]!, 'approve');
  assert.equal((await approved).content, 'hi');
  assert.equal(runs, 1);

  const rejected = executor.execute(
    { ...call, id: 'c2' },
    { executionId: 'e2' },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const rejectId = approval.listPending()[0]!.id;
  approval.decide(rejectId, 'reject');
  const rejectResult = await rejected;
  assert.equal(rejectResult.status, 'error');
  assert.equal(runs, 1);

  const expired = await executor.execute(
    { ...call, id: 'c3' },
    { executionId: 'e3', approvalTimeoutMs: 20 },
  );
  assert.equal(expired.status, 'error');
  assert.match(expired.content, /timed out|Approval/i);
  assert.equal(runs, 1);

  const controller = new AbortController();
  const cancelling = executor.execute(
    { ...call, id: 'c4' },
    { executionId: 'e4', signal: controller.signal },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const lateId = approval.listPending()[0]!.id;
  controller.abort();
  await assert.rejects(
    cancelling,
    (error: unknown) =>
      error instanceof ToolExecutionError && error.code === 'aborted',
  );
  assert.throws(
    () => approval.decide(lateId, 'approve'),
    (error: unknown) =>
      error instanceof ApprovalError && error.code === 'not_pending',
  );
  assert.equal(runs, 1);
});

test('审批等待不持 Workspace 锁；无通道时 always 失败关闭', async () => {
  const registry = new DefaultToolRegistry();
  let inside = false;
  registry.register(
    echoSpec,
    () => {
      inside = true;
      return { content: 'x' };
    },
    { approval: 'always', workspaceAccess: 'write' },
  );
  const coordinator = new WorkspaceAccessCoordinator();
  const approval = new ApprovalService();
  approval.subscribe(() => {});
  const executor = new GuardedToolExecutor(registry, {
    approval,
    coordinator,
  });
  let releaseHold!: () => void;
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  const holder = coordinator.run({
    workspaceId: 'ws',
    access: 'write',
    task: async () => {
      await hold;
      return 'held';
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const gated = executor.execute(
    { id: 'c1', name: 'echo', argumentsJson: '{"text":"a"}' },
    { executionId: 'e1', workspaceId: 'ws' },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(approval.listPending().length, 1);
  assert.equal(inside, false);
  approval.decide(approval.listPending()[0]!.id, 'approve');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inside, false);
  releaseHold();
  await holder;
  assert.equal((await gated).status, 'success');
  assert.equal(inside, true);

  const noListener = new ApprovalService();
  const noChannel = new GuardedToolExecutor(registry, {
    approval: noListener,
    coordinator,
  });
  const unavailable = await noChannel.execute(
    { id: 'c2', name: 'echo', argumentsJson: '{"text":"a"}' },
    { executionId: 'e2', workspaceId: 'ws' },
  );
  assert.equal(unavailable.status, 'error');
  assert.match(unavailable.content, /approval channel|unavailable/i);

  const closedApproval = new ApprovalService();
  closedApproval.subscribe(() => {});
  closedApproval.setChannelOpen(false);
  const closed = new GuardedToolExecutor(registry, {
    approval: closedApproval,
    coordinator,
  });
  const failed = await closed.execute(
    { id: 'c3', name: 'echo', argumentsJson: '{"text":"a"}' },
    { executionId: 'e3', workspaceId: 'ws' },
  );
  assert.equal(failed.status, 'error');
});

test('never 审批跳过；UNSAFE 在获锁后返回明确错误', async () => {
  const registry = new DefaultToolRegistry();
  registry.register(echoSpec, (args) => ({ content: String(args.text) }), {
    approval: 'never',
    workspaceAccess: 'read',
  });
  const coordinator = new WorkspaceAccessCoordinator();
  coordinator.markUnsafe('ws');
  const executor = new GuardedToolExecutor(registry, {
    approval: new ApprovalService(),
    coordinator,
  });
  const result = await executor.execute(
    { id: 'c1', name: 'echo', argumentsJson: '{"text":"z"}' },
    { executionId: 'e1', workspaceId: 'ws' },
  );
  assert.equal(result.status, 'error');
  assert.match(result.content, /unsafe/i);
  coordinator.recover('ws');
  assert.equal(
    (
      await executor.execute(
        { id: 'c2', name: 'echo', argumentsJson: '{"text":"z"}' },
        { executionId: 'e2', workspaceId: 'ws' },
      )
    ).content,
    'z',
  );
  assert.ok(WorkspaceError);
});
