export type ApprovalErrorCode =
  | 'not_found'
  | 'not_pending'
  | 'rejected'
  | 'cancelled'
  | 'expired'
  | 'unavailable'
  | 'invalid_request';

const messages: Record<ApprovalErrorCode, string> = {
  not_found: 'Approval request was not found.',
  not_pending: 'Approval request is no longer pending.',
  rejected: 'Tool execution was rejected.',
  cancelled: 'Approval was cancelled.',
  expired: 'Approval wait timed out.',
  unavailable: 'No approval channel is available.',
  invalid_request: 'Approval request is invalid.',
};

export class ApprovalError extends Error {
  readonly code: ApprovalErrorCode;

  constructor(code: ApprovalErrorCode, message = messages[code]) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
  }
}
