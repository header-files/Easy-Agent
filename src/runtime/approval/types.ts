export type ApprovalStatus =
  'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED';

export interface ApprovalRequest {
  readonly id: string;
  readonly executionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly argumentsHash: string;
  readonly workspaceId?: string;
  readonly status: ApprovalStatus;
  readonly createdAt: string;
}

export type ApprovalDecision = 'approve' | 'reject';
