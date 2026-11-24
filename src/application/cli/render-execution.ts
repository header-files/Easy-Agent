import type { Writable } from 'node:stream';
import type { SessionExecution } from '../../harness/contracts/agent/index.ts';
import type { ExecutionResult } from '../../harness/contracts/execution/index.ts';

/** Observe presentation only; neither an observation error nor return cancels work. */
export async function renderExecution(
  execution: SessionExecution,
  output: Writable,
  error: Writable,
  stream: boolean,
): Promise<ExecutionResult['status'] | 'ERROR'> {
  // Attach rejection handling before consuming the independently-lived observation.
  const final = execution.result.then(
    (result) => ({ result }),
    () => ({ result: undefined }),
  );
  let shown = '';
  try {
    for await (const item of execution.events) {
      if (
        stream &&
        item.type === 'loop_event' &&
        item.event.type === 'model_event' &&
        item.event.event.type === 'message_start'
      ) {
        // DefaultAgentLoop may show explanatory text before tools, but its
        // final output is the last model response, not every response joined.
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
      // A terminal/pipe cannot retract already written bytes. Mark replacement,
      // rather than silently appending the full answer as another text delta.
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
