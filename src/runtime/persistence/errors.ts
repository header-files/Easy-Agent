export type PersistenceErrorCode =
  | 'invalid_record'
  | 'corrupt_store'
  | 'conflict'
  | 'not_prepared'
  | 'commit_uncertain'
  | 'io_failed'
  | 'lock_failed'
  | 'unavailable'
  | 'invalid_request'
  | 'projection_refresh_failed';

const messages: Record<PersistenceErrorCode, string> = {
  invalid_record: 'Persistence record is invalid.',
  corrupt_store:
    'Persistence store is corrupt and cannot be recovered automatically.',
  conflict: 'Persistence record conflict detected.',
  not_prepared: 'Transaction was not durably prepared.',
  commit_uncertain: 'Transaction commit outcome is uncertain.',
  io_failed: 'Persistence I/O failed.',
  lock_failed: 'Data directory write lock could not be acquired.',
  unavailable: 'Persistence is unavailable.',
  invalid_request: 'Persistence request is invalid.',
  projection_refresh_failed:
    'Durable commit succeeded but projection refresh failed.',
};

export interface PersistenceErrorOptions {
  /** Journal COMMITTED completed; in-memory projection may be stale. */
  durableCommitted?: boolean;
  transactionId?: string;
}

export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;
  /** True when the Journal transaction already reached COMMITTED. */
  readonly durableCommitted: boolean;
  readonly transactionId: string | undefined;

  constructor(
    code: PersistenceErrorCode,
    message?: string,
    options?: PersistenceErrorOptions,
  ) {
    super(message ?? messages[code]);
    this.name = 'PersistenceError';
    this.code = code;
    this.durableCommitted = options?.durableCommitted === true;
    this.transactionId = options?.transactionId;
  }
}

/** True when durable ops committed even if a later step (e.g. refresh) failed. */
export function isDurableCommittedFailure(error: unknown): boolean {
  return error instanceof PersistenceError && error.durableCommitted;
}

/**
 * True when Journal/ops durability is unknown (must not roll back as "did not happen").
 */
export function isCommitUncertain(error: unknown): boolean {
  return error instanceof PersistenceError && error.code === 'commit_uncertain';
}
