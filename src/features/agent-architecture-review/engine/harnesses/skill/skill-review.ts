/**
 * The skill harness: review one uploaded artifact under ART's rubric.
 *
 * Every rule, weight and threshold lives in ART's `reviewArtifact`. This module supplies the two
 * things it cannot supply for itself inside a snapshot — an AI stage bound to this engine's job port
 * and the upload's subject identity — and translates ART's stage names into the shared snapshot
 * vocabulary. It contributes no rule and no arithmetic.
 *
 * ## Why there is no capture
 *
 * The other two harnesses start from an agent that exists in an environment, so they capture it
 * first and the capture decides the rubric. An upload has no environment and no bot row: the file
 * *is* the evidence, and the rubric is decided by what the file turns out to be. So this arm takes
 * an artifact rather than an `AgentCapture`, and `reviewAgent` never routes to it.
 *
 * ## Why there is no runtime analysis
 *
 * Runtime analysis reads conversation transcripts. A skill has no conversations of its own — it runs
 * inside whichever agent loads it — so there is nothing to read. See `harness-skill.md` §5.
 */

import type { AgentReviewStage } from '../../contracts/review-progress';
import type { ReviewJobPort } from '../../dispatch/review-job-port';
import {
  hasScore,
  overallScoreOf,
  reviewArtifact,
  type ArtifactReviewProgress,
  type ArtifactReviewResult,
  type PredictTransport,
  type ReviewModelIds,
  type TargetRuntime,
  type UploadedArtifact,
} from '../../scoring/art-ports';
import { createSkillAiStage } from './skill-ai-stage';
import type { SkillIdentity } from './skill-identity';

/** Progress this harness reports for a single uploaded skill. */
export interface SkillReviewProgress {
  stage: AgentReviewStage;
  detail: string;
}

export interface SkillReviewOptions {
  artifact: UploadedArtifact;
  /** The runtimes the author ticked. Never detected — no artifact declares its target platform. */
  runtimes: TargetRuntime[];
  identity: SkillIdentity;
  jobs: ReviewJobPort;
  predict: PredictTransport;
  onJobSubmitted?: (jobId: string) => void;
  onProgress?: (progress: SkillReviewProgress) => void;
  existingJobId?: string;
  modelIds?: ReviewModelIds;
  signal?: AbortSignal;
}

export interface SkillReviewOutcome {
  /** ART's artifact review contract, unsaved. The engine writes it with the snapshot binding. */
  reviewResult: ArtifactReviewResult;
  /**
   * ART's weighted rubric score, or null when no dimension could be assessed.
   *
   * Null rather than 0, because `overallScoreOf` returns 0 for "nothing was assessed" and a snapshot
   * that reports 0 reads as a failing skill rather than an unavailable review.
   */
  score: number | null;
  jobId: string | null;
  startedAt: string;
  completedAt: string;
}

/**
 * ART's six artifact stages, mapped onto the snapshot's.
 *
 * A total record rather than substring matching, because the stage union is closed: if ART adds or
 * renames a stage this stops compiling, which is the point.
 */
const STAGE_MAP: Record<ArtifactReviewProgress['stage'], AgentReviewStage> = {
  reading: 'parsing-configuration',
  detecting: 'parsing-configuration',
  deterministic: 'evaluating-patterns',
  ai: 'checking-compliance',
  scoring: 'saving-results',
  complete: 'saving-results',
};

/**
 * Review one uploaded skill.
 *
 * The AI stage is built here rather than passed in so that the job id it submits can be read back
 * afterwards: `reviewArtifact` takes the stage as a bare function and has nowhere to return one.
 */
export async function reviewSkillArtifact(
  options: SkillReviewOptions,
): Promise<SkillReviewOutcome> {
  const { artifact, runtimes, identity, jobs, predict, onProgress, signal } = options;
  const startedAt = new Date().toISOString();

  const stage = createSkillAiStage({
    identity,
    jobs,
    predict,
    ...(options.onJobSubmitted ? { onJobSubmitted: options.onJobSubmitted } : {}),
    ...(options.existingJobId ? { existingJobId: options.existingJobId } : {}),
    ...(options.modelIds ? { modelIds: options.modelIds } : {}),
    ...(signal ? { signal } : {}),
    onProgress: (p) => onProgress?.({ stage: 'checking-compliance', detail: p.message }),
  });

  const reviewResult = await reviewArtifact(
    {
      artifact,
      runtimes,
      onProgress: (p) => onProgress?.({ stage: STAGE_MAP[p.stage], detail: p.message }),
      ...(signal ? { signal } : {}),
    },
    {
      runAiStage: stage.runAiStage,
      // No `onReserve`. ART announces the review to its own grid before the AI stage so a closed
      // browser still shows it as running; a snapshot already has a durable row of its own for
      // exactly that, written before this function is called.
    },
  );

  await stage.ensureWorkflowSettled();

  return {
    reviewResult,
    score: hasScore(reviewResult) ? overallScoreOf(reviewResult) : null,
    jobId: stage.submittedJobId,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}
