/**
 * The declarative-agent harness: review one uploaded DA package under ART's rubric.
 *
 * Every rule, weight and threshold lives in ART's stages. This module supplies the two things they
 * cannot supply for themselves inside a snapshot — a workflow transport bound to this engine's job
 * port, and a correlation id stamped with the snapshot — and translates the stage names into the
 * shared snapshot vocabulary. It contributes no rule and no arithmetic.
 *
 * A sibling of `skill/skill-review.ts`, not a branch of it. Both review an upload, and that is where
 * the similarity ends: a skill upload is a list of skills judged against a runtime the author picks,
 * while a DA package is exactly one agent judged against its own six-criterion rubric with no
 * runtime at all. The two share the job port, which is the part worth sharing.
 *
 * ## Why this is not `executeDAReviewPipeline`
 *
 * ART's hook is the same sequence plus two things this app must not inherit. It calls `evaluateDA`,
 * an AI Builder stage that is unreachable on the zip path and is only ever a fallback for the Graph
 * path; and it calls `upsertDAReview`, which binds a generated Dataverse service and writes to ART's
 * own table rather than to this snapshot. Composing the pure stages here keeps the review identical
 * while the I/O and the persistence stay this engine's.
 *
 * ## No availability pre-flight, deliberately
 *
 * ART calls `assertReviewWorkflowAvailable` before submitting. That function reaches two
 * `src/generated/**` services, so it cannot cross the `art-ports` seam, and no harness in this app
 * performs that pre-flight. An unreachable workflow surfaces here exactly as it does for every other
 * harness: `pollReviewJob` gives up at the unclaimed-job window and throws `workflow-unavailable`,
 * which is the degradation path the rest of the engine is already built around.
 *
 * Browser-safe. No `Buffer`, no `process`, no generated Dataverse client.
 */

import type { AgentReviewStage } from '../../contracts/review-progress';
import type { ReviewJobPort } from '../../dispatch/review-job-port';
import {
  applyDAEvaluationApplicability,
  buildDAWorkflowRequest,
  calculateDAScore,
  evaluateDAWorkflowRequest,
  runDAPackageValidation,
  runManifestHealthCheck,
  type DAEvaluationResult,
  type DAEvidenceRecord,
  type DAManifest,
  type DAPackageValidation,
  type DAWorkflowProvenance,
  type ManifestHealthCheck,
} from '../../scoring/art-ports';
import { createDAWorkflowTransport, stampDACorrelation } from './da-transport';
import type { DetectedDeclarativeAgent } from './da-detection';

/** Progress this harness reports for a single declarative agent. */
export interface DeclarativeAgentReviewProgress {
  stage: AgentReviewStage;
  detail: string;
}

export interface DeclarativeAgentReviewOptions {
  /** The package, already read by `detectDeclarativeAgent`. This module does no I/O of its own. */
  agent: DetectedDeclarativeAgent;
  jobs: ReviewJobPort;
  /**
   * The snapshot this review belongs to.
   *
   * Required, not optional, because it is half the correlation id. `createReviewJob` rewrites the
   * row's `cat_correlationid` to `snapshotId:botId` whenever the port carries a stamp, and
   * `parseDAReviewJobRows` rejects per rule on any disagreement — so a request built without it
   * comes back with every rule rejected and a review that reports nothing.
   */
  snapshotId: string;
  /** A job already submitted for this subject, from the resume map. Skips creation. */
  existingJobId?: string;
  onJobSubmitted?: (jobId: string) => void;
  onProgress?: (progress: DeclarativeAgentReviewProgress) => void;
  signal?: AbortSignal;
}

/** ART's DA review, assembled but unsaved. The engine writes it with the snapshot binding. */
export interface DeclarativeAgentReviewResult {
  manifest: DAManifest;
  manifestHealth: ManifestHealthCheck;
  packageValidation: DAPackageValidation;
  /** Applicability already applied, so a criterion the package cannot have is not graded as failed. */
  evaluation: DAEvaluationResult;
  workflowProvenance: DAWorkflowProvenance;
  /** The redacted records every finding was checked against, as sent to the workflow. */
  evidence: DAEvidenceRecord[];
}

export interface DeclarativeAgentReviewOutcome {
  reviewResult: DeclarativeAgentReviewResult;
  /**
   * ART's weighted rubric score, or null when no criterion could be assessed.
   *
   * `calculateDAScore` already returns null for that case rather than 0, and it is passed through
   * unchanged: a snapshot that reports 0 reads as a failing agent rather than an unavailable review.
   */
  score: number | null;
  jobId: string | null;
  startedAt: string;
  completedAt: string;
}

/**
 * Review one declarative agent package.
 *
 * The transport is built here rather than passed in so the job id it submits can be read back
 * afterwards: `evaluateDAWorkflowRequest` takes the transport as a bare function and returns the id
 * only inside its provenance, which is too late for the progress row to show a running job.
 */
export async function reviewDeclarativeAgent(
  options: DeclarativeAgentReviewOptions,
): Promise<DeclarativeAgentReviewOutcome> {
  const { agent, jobs, snapshotId, existingJobId, onJobSubmitted, onProgress, signal } = options;
  const { manifest, packageEvidence, skillBundles } = agent;
  const startedAt = new Date().toISOString();

  signal?.throwIfAborted();

  // ---- deterministic stages --------------------------------------------------------------

  onProgress?.({ stage: 'parsing-configuration', detail: 'Checking manifest health' });
  const manifestHealth = runManifestHealthCheck(manifest);

  onProgress?.({ stage: 'evaluating-patterns', detail: 'Validating the package' });
  const packageValidation = runDAPackageValidation(manifest, packageEvidence, skillBundles);

  // Custom skills are deliberately not reviewed here. `reviewDACustomSkills` binds a generated
  // Dataverse service and is absent from `art-ports` for that reason; a DA's own six criteria are
  // graded on the package as submitted, which is the review this app renders.

  signal?.throwIfAborted();

  // ---- workflow stage --------------------------------------------------------------------

  // The correlation id is allocated by `stampDACorrelation` rather than at random, because the job
  // row will carry `snapshotId:botId` whatever this request says, and the parser matches on it.
  // `buildDAWorkflowRequest` needs *a* value to build with; the stamp then replaces it with the one
  // the rows come back carrying. Taking the agent id off the built request is what keeps the two
  // DA identifiers from being confused — the corpus stamps `review.botId` from `agent.id`, while
  // the subject a review is *stored* under comes from `getDAIdentifier`, and they are not equal.
  const workflowRequest = stampDACorrelation(
    buildDAWorkflowRequest(manifest, packageEvidence, { correlationId: snapshotId }),
    snapshotId,
  );

  let jobId: string | null = existingJobId ?? null;

  onProgress?.({ stage: 'checking-compliance', detail: 'Running quality evaluation' });

  const { evaluation: rawEvaluation, provenance } = await evaluateDAWorkflowRequest(
    manifest,
    workflowRequest,
    createDAWorkflowTransport({
      jobs,
      ...(existingJobId ? { existingJobId } : {}),
      ...(signal ? { signal } : {}),
      onJobSubmitted: (id) => {
        jobId = id;
        onJobSubmitted?.(id);
      },
      onPoll: (row) => {
        const status = row.cat_laststatus?.trim();
        onProgress?.({
          stage: 'checking-compliance',
          detail: status ? `Running quality evaluation: ${status}` : 'Running quality evaluation',
        });
      },
    }),
  );

  signal?.throwIfAborted();

  // ---- scoring ---------------------------------------------------------------------------

  onProgress?.({ stage: 'saving-results', detail: 'Scoring the review' });
  const evaluation = applyDAEvaluationApplicability(rawEvaluation, manifest);

  return {
    reviewResult: {
      manifest,
      manifestHealth,
      packageValidation,
      evaluation,
      workflowProvenance: provenance,
      evidence: workflowRequest.evidence,
    },
    score: calculateDAScore(evaluation),
    jobId: jobId ?? provenance.jobId ?? null,
    startedAt,
    completedAt: new Date().toISOString(),
  };
}
