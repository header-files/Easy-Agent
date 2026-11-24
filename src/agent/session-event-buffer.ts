import type { ExecutionEvent } from '../harness/contracts/execution/index.ts';
import { snapshot } from './snapshots.ts';

export class SessionEventBufferOverflowError extends Error {
  constructor() {
    super('Session execution event buffer overflowed.');
    this.name = 'SessionEventBufferOverflowError';
  }
}

/** Observation only: publishing never waits for a slow/absent reader. */
export class SessionEventBuffer {
  private readonly capacity: number;
  private queue: ExecutionEvent[] = [];
  private ended = false;
  private detached = false;
  private overflow = false;
  private claimed = false;
  private reader: ((step: IteratorResult<ExecutionEvent>) => void) | undefined;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  publish(event: ExecutionEvent): void {
    if (this.detached || this.overflow || this.ended) return;
    if (this.reader) {
      const value = snapshot(event);
      const reader = this.reader;
      this.reader = undefined;
      reader({ done: false, value });
      return;
    }
    if (this.queue.length >= this.capacity) {
      this.overflow = true;
      this.queue = [];
      return;
    }
    this.queue.push(snapshot(event));
  }

  finish(): void {
    this.ended = true;
    if (this.reader) {
      const reader = this.reader;
      this.reader = undefined;
      reader({ done: true, value: undefined });
    }
  }

  private detach(): void {
    this.detached = true;
    this.queue = [];
    this.finish();
  }

  readonly events: AsyncIterable<ExecutionEvent> = {
    [Symbol.asyncIterator]: () => {
      if (this.claimed)
        throw new Error('Session events can only be consumed once.');
      this.claimed = true;
      return {
        next: () => {
          if (this.detached)
            return Promise.resolve({ done: true, value: undefined });
          if (this.overflow)
            return Promise.reject(new SessionEventBufferOverflowError());
          const value = this.queue.shift();
          if (value) return Promise.resolve({ done: false, value });
          if (this.ended)
            return Promise.resolve({ done: true, value: undefined });
          if (this.reader)
            return Promise.reject(
              new Error('Concurrent session event reads are not supported.'),
            );
          return new Promise<IteratorResult<ExecutionEvent>>((resolve) => {
            this.reader = resolve;
          });
        },
        return: () => {
          this.detach();
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}
