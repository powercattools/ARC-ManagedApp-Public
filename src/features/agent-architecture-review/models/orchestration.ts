export const ORCHESTRATION_SCHEMA_VERSION = 1;

export interface ReviewRequest {
  schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
  kind: 'architecture-review-request';
  snapshotId: string;
  environmentId: string;
  organizationUrl: string;
  agentId: string;
  range: { start: string; end: string };
}

export interface AssessmentProgress {
  environmentId: string;
  agentId: string;
  agentName: string;
  stage: 'agent-review' | 'runtime';
  status: 'pending' | 'active' | 'succeeded' | 'no-data' | 'failed';
  jobId?: string;
  resultId?: string;
  error?: string;
}

export interface OrchestrationProgress {
  schemaVersion: typeof ORCHESTRATION_SCHEMA_VERSION;
  snapshotId: string;
  revision: number;
  status: 'queued' | 'preparing' | 'running' | 'needs-attention' | 'completed' | 'completed-with-gaps' | 'failed';
  updatedOn: string;
  assessments: AssessmentProgress[];
  gaps: string[];
  error?: string;
}

function orchestrationGuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Orchestration identities must be GUIDs.');
  }
  return value.toLowerCase();
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an orchestration object.');
  return value as Record<string, unknown>;
}

export function parseReviewRequest(value: unknown): ReviewRequest {
  const row = record(value);
  const range = record(row.range);
  if (row.schemaVersion !== ORCHESTRATION_SCHEMA_VERSION || row.kind !== 'architecture-review-request') {
    throw new Error('Unsupported review request schema.');
  }
  const { start, end } = range;
  const day = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/;
  if (typeof start !== 'string' || typeof end !== 'string' || !day.test(start) || !day.test(end) ||
      !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) ||
      new Date(start).toISOString() !== start || new Date(end).toISOString() !== end || start >= end) {
    throw new Error('Review requests require increasing, inclusive UTC calendar dates.');
  }
  if (typeof row.organizationUrl !== 'string') throw new Error('Review organization URL is required.');
  const url = new URL(row.organizationUrl);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.dynamics.com') || url.port || url.origin !== row.organizationUrl) {
    throw new Error('Review organization must be a canonical HTTPS Dataverse URL.');
  }
  return {
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION, kind: 'architecture-review-request',
    snapshotId: orchestrationGuid(row.snapshotId), environmentId: orchestrationGuid(row.environmentId),
    agentId: orchestrationGuid(row.agentId), organizationUrl: url.origin, range: { start, end },
  };
}
