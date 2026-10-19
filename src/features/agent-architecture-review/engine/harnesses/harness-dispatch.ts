/**
 * Choose the rubric for a captured agent.
 *
 * One place decides which harness reviews what, and it decides from the agent's own configuration
 * rather than from anything a caller passed in. A snapshot that graded a classic agent under the
 * copilot rubric — or the reverse — would produce a number that looks valid and is not, and nothing
 * downstream could tell.
 *
 * The outcome is a discriminated union rather than a lowest-common-denominator shape because the two
 * harnesses genuinely produce different evidence: copilot yields a workflow payload, standard yields
 * ART's review contract. Flattening them would force persistence to guess. What they do share —
 * `score`, `jobId`, `startedAt`, `completedAt` — is common to both arms, so the snapshot rollup reads
 * it without branching at all.
 */

import { reviewCopilotAgent, type CopilotReviewOutcome } from './copilot/copilot-review';
import { reviewStandardAgent, type StandardReviewOutcome } from './standard/standard-review';
import type { AgentCapture } from '../capture/agent-capture';
import type { ReviewJobPort } from '../dispatch/review-job-port';
import type { AgentReviewStage } from '../contracts/review-progress';
import type { PredictTransport, ReviewModelIds } from '../scoring/art-ports';

/** Progress any harness may report. The optional counts are only ever filled by the workflow. */
export interface HarnessReviewProgress {
  stage: AgentReviewStage;
  detail: string;
  componentCount?: number;
  completedComponents?: number;
}

export type HarnessReviewOutcome =
  | ({ harness: 'copilot' } & CopilotReviewOutcome)
  | ({ harness: 'standard' } & StandardReviewOutcome);

export interface HarnessReviewOptions {
  capture: AgentCapture;
  /** Both harnesses submit a workflow job; this is how either one reaches the job tables. */
  jobs: ReviewJobPort;
  /** Copilot only. The standard review is served entirely by the workflow. */
  predict: PredictTransport;
  onJobSubmitted?: (jobId: string) => void;
  onProgress?: (progress: HarnessReviewProgress) => void;
  /** Re-attach to a workflow job an interrupted run already submitted. */
  existingJobId?: string;
  modelIds?: ReviewModelIds;
  signal?: AbortSignal;
}

/** Review one captured agent under whichever rubric its harness calls for. */
export async function reviewAgent(options: HarnessReviewOptions): Promise<HarnessReviewOutcome> {
  const { capture, predict, onProgress, modelIds, signal } = options;

  if (capture.harness === 'standard') {
    const outcome = await reviewStandardAgent({
      capture,
      jobs: options.jobs,
      ...(options.onJobSubmitted ? { onJobSubmitted: options.onJobSubmitted } : {}),
      ...(onProgress ? { onProgress } : {}),
      ...(options.existingJobId ? { existingJobId: options.existingJobId } : {}),
      ...(signal ? { signal } : {}),
    });
    return { harness: 'standard', ...outcome };
  }

  const outcome = await reviewCopilotAgent({
    capture,
    jobs: options.jobs,
    predict,
    ...(options.onJobSubmitted ? { onJobSubmitted: options.onJobSubmitted } : {}),
    ...(onProgress ? { onProgress } : {}),
    ...(options.existingJobId ? { existingJobId: options.existingJobId } : {}),
    ...(modelIds ? { modelIds } : {}),
    ...(signal ? { signal } : {}),
  });
  return { harness: 'copilot', ...outcome };
}
