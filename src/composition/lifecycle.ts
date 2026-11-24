import {
  AgentApplicationError,
  type AgentApplicationService,
} from '../application/index.ts';
import type { SessionExecution } from '../harness/contracts/agent/index.ts';

/** Only outstanding handles for shutdown, never Session context, FIFO or scheduling. */
export function manageLifecycle(delegate: AgentApplicationService) {
  let closing = false;
  const active = new Map<SessionExecution, string>();
  function check() {
    if (closing) throw new AgentApplicationError('application_disposed');
  }
  const service: AgentApplicationService = {
    createSession(options) {
      check();
      return delegate.createSession(options);
    },
    listSessions() {
      check();
      return delegate.listSessions();
    },
    async deleteSession(id) {
      check();
      return delegate.deleteSession(id);
    },
    submit(id, input, options) {
      check();
      const execution = delegate.submit(id, input, options);
      active.set(execution, id);
      void execution.result.then(
        () => {
          active.delete(execution);
        },
        () => {
          active.delete(execution);
        },
      );
      return execution;
    },
    cancel(id, executionId) {
      check();
      return delegate.cancel(id, executionId);
    },
  };
  return {
    service,
    close() {
      closing = true;
    },
    async stop() {
      closing = true;
      const pending = [...active.entries()];
      let failed = false;
      for (const [execution, sessionId] of pending) {
        try {
          delegate.cancel(sessionId, execution.executionId);
        } catch {
          failed = true;
        }
      }
      const results = await Promise.allSettled(
        pending.map(([execution]) => execution.result),
      );
      if (failed || results.some((result) => result.status === 'rejected'))
        throw new Error('Application shutdown could not complete cleanly.');
    },
  };
}
