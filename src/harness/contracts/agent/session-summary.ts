export interface SessionSummary {
  sessionId: string;
  createdAt: string;
  runningExecutionId?: string;
  queuedCount: number;
}
