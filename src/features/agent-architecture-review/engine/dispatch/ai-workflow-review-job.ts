import { ReviewJobError, ReviewJobStatus, type ReviewJobRow } from '../scoring/art-ports';

/** Published ARC2Queued choice in cat_agentreviewjob.cat_jobstatus; ART's choices stay unchanged. */
export const ARC2_QUEUED_STATUS = 100000000;

function optionalText(value: unknown, column: string): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  throw new ReviewJobError('workflow-failed', `Review job ${column} is not text.`);
}

function optionalNumber(value: unknown, column: string): number | undefined {
  if (value == null) return undefined;
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  if (Number.isFinite(number)) return number;
  throw new ReviewJobError('workflow-failed', `Review job ${column} is not a number.`);
}

function logicalStatus(value: unknown): ReviewJobRow['cat_jobstatus'] {
  const status = optionalNumber(value, 'cat_jobstatus');
  switch (status) {
    case ARC2_QUEUED_STATUS:
      return ReviewJobStatus.Queued;
    case ReviewJobStatus.Queued:
    case ReviewJobStatus.Running:
    case ReviewJobStatus.Succeeded:
    case ReviewJobStatus.Failed:
    case undefined:
      return status;
    default:
      throw new ReviewJobError('workflow-failed', `Unrecognized review job status: ${status}.`);
  }
}

/**
 * Read the polling projection without casting ARC2's persisted queue value to an ART choice.
 *
 * This normalization is read-only: ARC2Queued becomes logical Queued for ART's polling/backoff
 * rules. Historical statuses and snapshot correlations keep their meaning, and the source row is
 * never mutated. Writes must use ARC2_QUEUED_STATUS directly, never this projection.
 */
export function normalizeArc2ReviewJob(value: unknown): ReviewJobRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ReviewJobError('workflow-failed', 'Read review job returned no row.');
  }
  if (
    !('cat_agentreviewjobid' in value)
    || typeof value.cat_agentreviewjobid !== 'string'
    || !value.cat_agentreviewjobid
  ) {
    throw new ReviewJobError('workflow-failed', 'Read review job returned no job id.');
  }

  return {
    cat_agentreviewjobid: value.cat_agentreviewjobid,
    cat_jobstatus: logicalStatus('cat_jobstatus' in value ? value.cat_jobstatus : undefined),
    cat_correlationid: optionalText(
      'cat_correlationid' in value ? value.cat_correlationid : undefined, 'cat_correlationid',
    ),
    cat_laststatus: optionalText(
      'cat_laststatus' in value ? value.cat_laststatus : undefined, 'cat_laststatus',
    ),
    cat_errormessage: optionalText(
      'cat_errormessage' in value ? value.cat_errormessage : undefined, 'cat_errormessage',
    ),
    cat_componentcount: optionalNumber(
      'cat_componentcount' in value ? value.cat_componentcount : undefined, 'cat_componentcount',
    ),
    modifiedon: optionalText('modifiedon' in value ? value.modifiedon : undefined, 'modifiedon'),
  };
}
