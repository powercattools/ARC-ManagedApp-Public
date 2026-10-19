/**
 * The standard (classic) harness: review one captured agent under ART's rubric.
 *
 * Every rule, weight and threshold lives in ART. This module supplies the three things ART cannot
 * supply for itself inside a snapshot — the frozen components, a Dataverse-backed job port, and the
 * snapshot stamp that keeps a re-review separable from the run before it — and translates the
 * workflow's progress into the shared snapshot vocabulary. It contributes no rule and no score.
 *
 * ## Why this looks like the copilot harness now
 *
 * Stages B and C used to be AI Builder prompts answered in the same HTTP response, which is why
 * this module once had no job id, no resume path and no component progress. They are now served by
 * the `Review Agent Components` workflow: a corpus is uploaded to a reserved row, the flow writes
 * one child row per review unit, and the client polls. The consequence is that a standard review is
 * durable in exactly the way a copilot review is — closing the dialog no longer loses it, and the
 * findings come back with the provenance of the job that produced them.
 *
 * Running the same flow as the Agent Review Tool is the whole point. When the two ran different
 * engines, the same agent scored differently depending on which product asked.
 *
 * The AI Builder prompts the migration replaced are gone — the workflow is the only engine. An
 * environment where the flow is off or its connection references are unbound reports every
 * compliance rule as "Could not run", which is the honest answer for an unfinished install.
 *
 * ## Why child agents do not appear here
 *
 * A classic agent's child agents are `AgentDialog` components inside the agent itself, not separate
 * agents, so they arrive in `capture.components` and ART already scores them as parent patterns. A
 * standard snapshot therefore reviews exactly one agent, however many children it declares.
 */

import type { StandardAgentCapture } from '../../capture/agent-capture';
import type { ReviewJobPort } from '../../dispatch/review-job-port';
import type { AgentReviewStage } from '../../contracts/review-progress';
import {
  assembleStandardReviewResult,
  buildStandardReviewWorkflowCorpus,
  extractStandardSnapshot,
  parseStandardReviewResultRows,
  pollReviewJob,
  projectStandardReviewWorkflow,
  tryBuildStandardReviewAssessmentIdentity,
  type ReviewResult,
  type StandardReviewWorkflowProvenance,
} from '../../scoring/art-ports';
import { normalizeStandardComponents } from './standard-component-normalization';

/** Progress this harness reports for a single agent. */
export interface StandardReviewProgress {
  stage: AgentReviewStage;
  detail: string;
  componentCount?: number;
  completedComponents?: number;
}

export interface StandardReviewOptions {
  capture: StandardAgentCapture;
  jobs: ReviewJobPort;
  /** Reported as soon as the durable job row exists, so a closed dialog can be resumed. */
  onJobSubmitted?: (jobId: string) => void;
  onProgress?: (progress: StandardReviewProgress) => void;
  /** Attach to a job already running instead of submitting a new one. */
  existingJobId?: string;
  signal?: AbortSignal;
}

export interface StandardReviewOutcome {
  /** ART's review contract, unsaved. The engine writes it with the snapshot binding. */
  reviewResult: ReviewResult;
  /** ART's overall score, or null when the rubric could not produce one. */
  score: number | null;
  jobId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

/**
 * Review one captured standard agent.
 *
 * Stage A runs against `capture.components` and never against the live environment: a fetch here
 * would grade whatever the agent looks like now against a snapshot taken earlier, and the two would
 * silently disagree.
 *
 * Cancellation is honoured by the poll itself, which is where nearly all of the wall-clock time is
 * spent; the boundary checks around it only cover the short stretches on either side.
 */
export async function reviewStandardAgent(
  options: StandardReviewOptions,
): Promise<StandardReviewOutcome> {
  const { capture, jobs, onProgress, signal } = options;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  const report = (
    stage: AgentReviewStage,
    detail: string,
    extra?: Partial<StandardReviewProgress>,
  ) => onProgress?.({ stage, detail, ...extra });

  const abortIfCancelled = () => {
    if (signal?.aborted) throw new Error('Review cancelled');
  };

  report('parsing-configuration', 'Reading agent configuration');
  abortIfCancelled();

  const stageA = extractStandardSnapshot(
    {
      botId: capture.botId,
      name: capture.botName,
      // Everything the Agent Review Tool's own fetch supplies. Dropping any of it does not make the
      // review lenient — it makes the agent look like one with no description, no settings and an
      // unknown orchestration mode, and the rules that read them would score it accordingly.
      description: capture.agentDescription,
      configuration: capture.configuration,
      agentSettings: capture.agentSettings,
    },
    normalizeStandardComponents(capture.components),
    // 'live', not 'zip'. The components were read from a real environment and merely frozen, and
    // the ZIP flag marks the evaluation-coverage check not-applicable — a snapshot that claimed to
    // be a ZIP would silently drop a rule the maker is expected to pass.
    'live',
  );

  const corpus = buildStandardReviewWorkflowCorpus(stageA, {
    correlationId: crypto.randomUUID(),
    sourceEnvironment: capture.organization,
  });
  const componentCount = corpus.standardReview.reviewUnits.length;

  report('evaluating-patterns', 'Submitting the review', { componentCount });
  abortIfCancelled();

  const jobId = options.existingJobId ?? (await jobs.createReviewJob(corpus));
  if (!options.existingJobId) options.onJobSubmitted?.(jobId);

  // The in-loop status ping says something finished but not how many — parallel iterations
  // overwrite each other's value. Counting the child rows is the only accurate measure, and it is
  // what turns the dialog's spinner into real "n of m" progress.
  const completedJob = await pollReviewJob({
    getJob: () => jobs.getReviewJob(jobId),
    ...(signal ? { signal } : {}),
    onPoll: async () => {
      const completedComponents = await jobs.countCompletedComponents(jobId);
      report('evaluating-patterns', 'Evaluating agent components', {
        componentCount,
        ...(completedComponents === undefined ? {} : { completedComponents }),
      });
    },
  });

  report('checking-compliance', 'Reading review findings', { componentCount });
  abortIfCancelled();

  const rows = await jobs.getReviewJobItemRows(jobId);
  const results = parseStandardReviewResultRows(rows, corpus);
  const evaluation = projectStandardReviewWorkflow(stageA, corpus, results);

  const workflowProvenance: StandardReviewWorkflowProvenance = {
    jobId,
    correlationId: completedJob?.cat_correlationid ?? corpus.review.correlationId,
    reviewPolicyVersion: corpus.reviewPolicyVersion,
    retrievedAt: new Date().toISOString(),
    rejectedCandidateCount: evaluation.rejectedCandidateCount,
    // Without this, a rejected candidate is only ever a count: the per-rule reason
    // the host used to reject it is lost, and the criterion's status cannot be explained.
    ...(evaluation.validationDiagnostics
      ? { validationDiagnostics: evaluation.validationDiagnostics }
      : {}),
    units: corpus.standardReview.reviewUnits.map((unit) => {
      const result = results.get(unit.componentIndex) as
        | { findings?: unknown; notAssessed?: unknown }
        | undefined;
      return {
        componentIndex: unit.componentIndex,
        unitId: unit.unitId,
        status: result ? 'succeeded' : 'missing',
        findingCount: Array.isArray(result?.findings) ? result.findings.length : 0,
        notAssessedCount: Array.isArray(result?.notAssessed) ? result.notAssessed.length : 0,
      };
    }),
  };

  report('saving-results', 'Scoring the review', { componentCount });

  const completedAt = new Date().toISOString();
  const durationMs = Date.now() - startMs;

  // Merging the deterministic patterns and deriving the two scores is ART's, not ours. The engine
  // only chooses when to save; what the numbers are is decided by the shared rubric.
  //
  // The identity is built here for the same reason. This review becomes the agent's newest version
  // in the shared review table, so the next ART review reads it as its consistency baseline — a
  // row saved without an identity is skipped there, and the comparison is lost with no error.
  // Losing it is the acceptable outcome; failing this review to report it is not, so the build is
  // allowed to come back empty.
  const assessmentIdentity = await tryBuildStandardReviewAssessmentIdentity(stageA);
  const reviewResult = assembleStandardReviewResult(
    stageA,
    { ...evaluation, workflowProvenance },
    {
      botId: capture.botId,
      botName: capture.botName,
      componentIdUnique: capture.componentIdUnique ?? '',
      sourceEnvironment: capture.organization,
      agentVersion: capture.agentVersion,
      assessmentIdentity,
    },
    durationMs,
  );

  return {
    reviewResult,
    score: reviewResult.overallScore ?? null,
    jobId,
    startedAt,
    completedAt,
    durationMs,
  };
}
