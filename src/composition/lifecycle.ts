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
      return Promise.resolve(delegate.createSession(options));
    },
    listModels() {
      check();
      return delegate.listModels();
    },
    getSessionModel(id) {
      check();
      return delegate.getSessionModel(id);
    },
    setSessionModel(id, modelId) {
      check();
      return Promise.resolve(delegate.setSessionModel(id, modelId));
    },
    listSessions() {
      check();
      return delegate.listSessions();
    },
    async deleteSession(id) {
      check();
      return delegate.deleteSession(id);
    },
    listSessionExecutions(id) {
      check();
      return delegate.listSessionExecutions(id);
    },
    getExecution(sessionId, executionId) {
      check();
      return delegate.getExecution(sessionId, executionId);
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
    registerWorkspace(name, path) {
      check();
      return delegate.registerWorkspace(name, path);
    },
    createWorkspace(name, path) {
      check();
      return delegate.createWorkspace(name, path);
    },
    listWorkspaces() {
      check();
      return delegate.listWorkspaces();
    },
    getWorkspaceStatus(id) {
      check();
      return delegate.getWorkspaceStatus(id);
    },
    recoverWorkspace(id) {
      check();
      return delegate.recoverWorkspace(id);
    },
    removeWorkspace(id) {
      check();
      return delegate.removeWorkspace(id);
    },
    getSessionWorkspaceId(id) {
      check();
      return delegate.getSessionWorkspaceId(id);
    },
    getTerminalShell() {
      check();
      return delegate.getTerminalShell();
    },
    listPendingApprovals() {
      check();
      return delegate.listPendingApprovals();
    },
    decideApproval(id, decision) {
      check();
      return delegate.decideApproval(id, decision);
    },
    subscribeApprovals(listener) {
      check();
      return delegate.subscribeApprovals(listener);
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
