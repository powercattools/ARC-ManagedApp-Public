import type { ReviewJobPort } from './review-job-port';
import {
  pollReviewJob,
  ReviewJobError,
  ReviewJobStatus,
  type PredictTransport,
  type ReviewJobRow,
} from '../scoring/art-ports';

/** The copied workflow's explicit disabled-state diagnostic, not an AI finding. */
export const ARC2_NOT_ENABLED = 'ARC2_NOT_ENABLED';

/**
 * Keep an ARC2 execution refusal out of ART's partial-result and prompt-fallback paths.
 *
 * ART intentionally catches failed AI stages so deterministic findings survive. This host must
 * still fail a disabled ARC2 submission instead of persisting that partial payload as a completed
 * review. Observe the parent without throwing from a polling read (which ART would retry), block
 * later predictions, and rethrow the original reason at the harness boundary before saving.
 */
export function createArc2WorkflowGuard(jobs: ReviewJobPort, predict: PredictTransport) {
  const observed = new Map<string, ReviewJobRow>();
  let disabled: ReviewJobError | undefined;

  const assertAvailable = () => {
    if (disabled) throw disabled;
  };

  const guardedJobs: ReviewJobPort = {
    ...jobs,
    async getReviewJob(jobId) {
      const row = await jobs.getReviewJob(jobId);
      observed.set(jobId, row);
      if (
        row.cat_jobstatus === ReviewJobStatus.Failed
        && row.cat_errormessage?.includes(ARC2_NOT_ENABLED)
      ) {
        disabled ??= new ReviewJobError('workflow-failed', row.cat_errormessage);
      }
      return row;
    },
    async getAgentLevelResult(jobId, index) {
      assertAvailable();
      return jobs.getAgentLevelResult(jobId, index);
    },
  };

  const guardedPredict: PredictTransport = async (...args) => {
    assertAvailable();
    return predict(...args);
  };

  return {
    jobs: guardedJobs,
    predict: guardedPredict,
    /** A rubric that skipped every AI-eligible unit must still observe the job it submitted. */
    async finish(jobId: string | null, signal?: AbortSignal): Promise<void> {
      assertAvailable();
      if (!jobId) return;
      const row = observed.get(jobId);
      if (
        row?.cat_jobstatus !== ReviewJobStatus.Succeeded
        && row?.cat_jobstatus !== ReviewJobStatus.Failed
      ) {
        await pollReviewJob({
          getJob: () => guardedJobs.getReviewJob(jobId),
          ...(signal ? { signal } : {}),
        });
      }
      assertAvailable();
    },
  };
}
