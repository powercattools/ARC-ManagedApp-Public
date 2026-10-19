import type { PersistedCopilotReviewPayload } from '../../contracts/ReviewResult';

/** Validate the required persisted fields before rendering a saved Copilot review. */
export function isPersistedCopilotPayload(value: unknown): value is PersistedCopilotReviewPayload {
  if (typeof value !== 'object' || value === null) return false;

  const payload = value as Record<string, unknown>;
  const model = payload.model;
  const score = payload.score;

  return (
    typeof model === 'object' && model !== null &&
    Array.isArray((model as Record<string, unknown>).tools) &&
    Array.isArray((model as Record<string, unknown>).skills) &&
    Array.isArray((model as Record<string, unknown>).connectedAgents) &&
    Array.isArray((model as Record<string, unknown>).knowledge) &&
    Array.isArray((model as Record<string, unknown>).testCases) &&
    Array.isArray((model as Record<string, unknown>).multiTurnCases) &&
    Array.isArray((model as Record<string, unknown>).evaluationSets) &&
    Array.isArray((model as Record<string, unknown>).triggers) &&
    Array.isArray((model as Record<string, unknown>).unknownKinds) &&
    typeof (model as Record<string, unknown>).agentSettings === 'object' &&
    (model as Record<string, unknown>).agentSettings !== null &&
    Array.isArray(payload.findings) &&
    Array.isArray(payload.skillEvaluations) &&
    Array.isArray(payload.skillBundleReviews) &&
    Array.isArray(payload.coverage) &&
    Array.isArray(payload.persistenceIssues) &&
    (payload.skillReviewMode === 'standard' || payload.skillReviewMode === 'deep') &&
    typeof score === 'object' && score !== null &&
    (
      typeof (score as Record<string, unknown>).grounded === 'number' ||
      (score as Record<string, unknown>).grounded === null
    ) &&
    typeof (score as Record<string, unknown>).passed === 'number' &&
    typeof (score as Record<string, unknown>).warnings === 'number' &&
    typeof (score as Record<string, unknown>).errors === 'number' &&
    typeof (score as Record<string, unknown>).evaluated === 'number'
  );
}

/**
 * Validates a persisted payload and supplies defaults for supported legacy fields.
 */
export function parsePersistedCopilotPayload(
  value: unknown,
): PersistedCopilotReviewPayload | undefined {
  if (typeof value !== 'object' || value === null) return undefined;

  const payload = value as Record<string, unknown>;
  const model = payload.model;
  if (typeof model !== 'object' || model === null) return undefined;

  const modelRecord = model as Record<string, unknown>;
  const normalized = modelRecord.triggers === undefined
    ? {
        ...payload,
        model: {
          ...modelRecord,
          triggers: [],
        },
      }
    : value;

  return isPersistedCopilotPayload(normalized) ? normalized : undefined;
}
