import type { CallContext } from './call-context.ts';
import { invalidResponse } from './errors.ts';

/** Decode SSE incrementally, including UTF-8 and CRLF split across network reads. */
export async function* sse(
  body: ReadableStream<Uint8Array>,
  context: CallContext,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  context.controller.signal.addEventListener('abort', cancel, { once: true });
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let fields: string[] = [];
  let skipLF = false;
  const line = (value: string): string | undefined => {
    if (value === '') {
      if (!fields.length) return undefined;
      const data = fields.join('\n');
      fields = [];
      return data;
    }
    if (value === 'data') fields.push('');
    else if (value.startsWith('data:'))
      fields.push(value.slice(value[5] === ' ' ? 6 : 5));
    return undefined;
  };
  try {
    while (true) {
      const result = await context.run(reader.read());
      let decoded: string;
      try {
        decoded = result.done
          ? decoder.decode()
          : decoder.decode(result.value, { stream: true });
      } catch {
        return invalidResponse();
      }
      for (const character of decoded) {
        if (skipLF && character === '\n') {
          skipLF = false;
          continue;
        }
        skipLF = false;
        if (character === '\r' || character === '\n') {
          const data = line(buffer);
          buffer = '';
          skipLF = character === '\r';
          if (data !== undefined) yield data;
        } else buffer += character;
      }
      if (result.done) {
        if (buffer) line(buffer);
        const data = line('');
        if (data !== undefined) yield data;
        return;
      }
    }
  } finally {
    // Do not let an uncooperative transport delay caller cancellation/return.
    context.controller.signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
