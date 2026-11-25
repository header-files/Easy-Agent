import type { Readable, Writable } from 'node:stream';
import type { SessionExecution } from '../../harness/contracts/agent/index.ts';
import type { ExecutionResult } from '../../harness/contracts/execution/index.ts';
import type { AgentApplicationService } from '../agent-application-service.ts';
import type { ApprovalRequest } from '../../runtime/approval/index.ts';

export interface RenderExecutionOptions {
  service?: AgentApplicationService;
  ask?: (question: string) => Promise<string>;
  /**
   * When set, approval prompts are already handled by this subscription and
   * renderExecution will not subscribe/unsubscribe.
   */
  approvalSubscriptionActive?: boolean;
}

/** Subscribe before submit so ApprovalService fail-closed sees a decision channel. */
export function subscribeApprovalPrompts(
  service: AgentApplicationService,
  output: Writable,
  error: Writable,
  ask?: (question: string) => Promise<string>,
): () => void {
  const pendingPrompts = new Set<string>();
  return service.subscribeApprovals((request) => {
    if (request.status !== 'PENDING') return;
    if (pendingPrompts.has(request.id)) return;
    pendingPrompts.add(request.id);
    void promptApproval(request, service, output, error, ask).finally(() =>
      pendingPrompts.delete(request.id),
    );
  });
}

/** Observe presentation only; neither an observation error nor return cancels work. */
export async function renderExecution(
  execution: SessionExecution,
  output: Writable,
  error: Writable,
  stream: boolean,
  options: RenderExecutionOptions = {},
): Promise<ExecutionResult['status'] | 'ERROR'> {
  const final = execution.result.then(
    (result) => ({ result }),
    () => ({ result: undefined }),
  );
  let shown = '';
  const unsubscribe =
    options.service === undefined || options.approvalSubscriptionActive
      ? undefined
      : subscribeApprovalPrompts(options.service, output, error, options.ask);
  try {
    for await (const item of execution.events) {
      if (
        stream &&
        item.type === 'loop_event' &&
        item.event.type === 'model_event' &&
        item.event.event.type === 'message_start'
      ) {
        if (shown && !shown.endsWith('\n')) output.write('\n');
        shown = '';
      }
      if (
        stream &&
        item.type === 'loop_event' &&
        item.event.type === 'output_delta'
      ) {
        output.write(item.event.content);
        shown += item.event.content;
      }
    }
  } catch {
    error.write('事件观察中断，正在等待最终结果。\n');
  } finally {
    unsubscribe?.();
  }
  const { result } = await final;
  if (result === undefined) {
    if (shown && !shown.endsWith('\n')) output.write('\n');
    error.write('[ERROR] 无法获取最终结果。\n');
    return 'ERROR';
  }
  if (result.status === 'COMPLETED') {
    const answer = result.loopResult.output ?? '';
    if (answer.startsWith(shown)) {
      output.write(answer.slice(shown.length));
    } else {
      output.write('\n[最终答案，替换此前预览]\n');
      output.write(answer);
    }
    if (!answer.endsWith('\n')) output.write('\n');
    output.write('[COMPLETED]\n');
  } else {
    if (shown && !shown.endsWith('\n')) output.write('\n');
    if (result.status === 'CANCELLED') output.write('[CANCELLED]\n');
    else error.write(`[FAILED: ${result.error.code}] 执行失败。\n`);
  }
  return result.status;
}

const SENSITIVE_KEYS = new Set([
  'content',
  'newtext',
  'oldtext',
  'body',
  'text',
  'password',
  'token',
  'secret',
  'apikey',
  'authorization',
]);

async function promptApproval(
  request: ApprovalRequest,
  service: AgentApplicationService,
  output: Writable,
  error: Writable,
  ask?: (question: string) => Promise<string>,
): Promise<void> {
  const args = request.arguments;
  const command = typeof args.command === 'string' ? args.command : undefined;
  const filePath = typeof args.path === 'string' ? args.path : undefined;
  let workspaceLine = request.workspaceId ?? '(none)';
  if (request.workspaceId) {
    try {
      const status = service.getWorkspaceStatus(request.workspaceId);
      workspaceLine = `${status.name} ${status.id} root=${status.rootPath}`;
    } catch {
      /* keep id */
    }
  }
  output.write(`\n[审批] tool=${request.toolName}\n`);
  output.write(`  workspace: ${workspaceLine}\n`);
  output.write(`  shell: ${service.getTerminalShell()}\n`);
  output.write(`  cwd: . (workspace root; Terminal 非文件系统沙箱)\n`);
  // Path shown in full (operation identity). Command shown after heuristic
  // redaction so approval stays reviewable without echoing common secrets;
  // argsHash covers the exact approved payload.
  if (command !== undefined) {
    const shown = redactCommandForDisplay(command);
    output.write(`  command: ${shown.text}\n`);
    output.write(
      `  commandChars: ${Buffer.byteLength(command, 'utf8')}${shown.redacted ? ' (display redacted; hash is authoritative)' : ''}\n`,
    );
  }
  if (filePath !== undefined) {
    output.write(`  path: ${filePath}\n`);
  }
  if (args.overwrite !== undefined) {
    output.write(`  overwrite: ${String(args.overwrite)}\n`);
  }
  for (const [key, value] of Object.entries(args)) {
    if (key === 'command' || key === 'path' || key === 'overwrite') continue;
    output.write(`  ${key}: ${summarizeArg(key, value)}\n`);
  }
  output.write(`  argsHash: ${request.argumentsHash}\n`);
  output.write(
    '批准输入 y，拒绝输入 n（写文件/Terminal 不受强文件系统沙箱保护）。\n',
  );
  if (!ask) {
    try {
      service.decideApproval(request.id, 'reject');
    } catch {
      /* already settled */
    }
    error.write('无交互审批通道，已拒绝该工具调用。\n');
    return;
  }
  try {
    const answer = (await ask('批准? [y/N] ')).trim().toLowerCase();
    service.decideApproval(
      request.id,
      answer === 'y' || answer === 'yes' ? 'approve' : 'reject',
    );
  } catch {
    try {
      service.decideApproval(request.id, 'reject');
    } catch {
      /* already settled */
    }
  }
}

/** Never print full sensitive payloads; show size/type only. */
function summarizeArg(key: string, value: unknown): string {
  if (SENSITIVE_KEYS.has(key.toLowerCase())) {
    if (typeof value === 'string') {
      return `<redacted string ${Buffer.byteLength(value, 'utf8')} bytes>`;
    }
    return `<redacted ${typeof value}>`;
  }
  if (typeof value === 'string') {
    return value.length <= 4_000
      ? value
      : `${value.slice(0, 4_000)}… <total ${value.length} chars>`;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null) return 'null';
  try {
    const json = JSON.stringify(value);
    return json.length <= 500
      ? json
      : `<${typeof value} ${json.length} chars, not shown>`;
  } catch {
    return `<${typeof value}>`;
  }
}

/**
 * Credential-like token: stops at whitespace and Shell metacharacters so
 * `abc&&rm` / `abc;touch` / `abc|sh` keep the operator and following command.
 */
const CREDENTIAL_TOKEN = '[A-Za-z0-9._~+/=\\-]+';

/**
 * Heuristic display redaction for Shell commands. Not a secret detector:
 * approval still binds the full frozen command via argsHash / executor args.
 *
 * Patterns must redact only the credential token — never consume shell
 * metacharacters or following commands (`&&`, `|`, `;`, etc.).
 */
export function redactCommandForDisplay(command: string): {
  text: string;
  redacted: boolean;
} {
  let text = command;
  const before = text;
  // Authorization: Bearer <token>  or  Authorization:<token>  (one token only)
  text = text.replace(
    new RegExp(
      `\\bAuthorization\\s*:\\s*Bearer\\s+(${CREDENTIAL_TOKEN})`,
      'gi',
    ),
    'Authorization: Bearer <redacted>',
  );
  text = text.replace(
    new RegExp(
      `\\bAuthorization\\s*:\\s*(?!Bearer\\b)(${CREDENTIAL_TOKEN})`,
      'gi',
    ),
    'Authorization:<redacted>',
  );
  text = text.replace(
    new RegExp(`\\bBearer\\s+${CREDENTIAL_TOKEN}`, 'gi'),
    'Bearer <redacted>',
  );
  text = text.replace(
    new RegExp(
      `\\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key)\\s*[=:]\\s*(['"]?)(${CREDENTIAL_TOKEN})\\2`,
      'gi',
    ),
    (match, key: string) =>
      `${key}${match.includes('=') ? '=' : ':'}<redacted>`,
  );
  text = text.replace(
    new RegExp(
      `(--?(?:password|passwd|token|secret|api[_-]?key))\\s+(['"]?)(${CREDENTIAL_TOKEN})\\2`,
      'gi',
    ),
    (_match, key: string) => `${key} <redacted>`,
  );
  text = text.replace(/\bsk-[A-Za-z0-9]{16,}\b/g, '<redacted>');
  text = text.replace(/\bghp_[A-Za-z0-9]{20,}\b/g, '<redacted>');
  text = text.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '<redacted>');
  return { text, redacted: text !== before };
}

export type { Readable };
