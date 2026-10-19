/**
 * Drive one snapshot of an uploaded declarative agent package.
 *
 * A sibling of `runUploadSnapshot`, not a branch of it, for the same reason that one is a sibling
 * of `runSnapshot`: the three start from different things. An agent run starts from a bot id and
 * expands a graph, a skill upload starts from a list of files and reviews each skill against a
 * chosen runtime, and a declarative agent package is exactly one subject graded on its own
 * six-criterion rubric with no runtime to choose. Folding them together would mean each carrying a
 * parameter the other two must remember to ignore.
 *
 * Everything after the subject is known is shared: the same progress contract, the same per-subject
 * job port, the same incremental persistence callback, the same resume map.
 *
 * ## What is deliberately absent
 *
 * **No fan-out.** A package declares one agent, so there is one subject and nothing to pool. The
 * custom skills inside it are evidence the rubric reads, not subjects of their own.
 *
 * **No runtime analysis, and no runtimes to pick.** A declarative agent has no conversations in this
 * environment to read, and its rubric names no target platform to grade against.
 *
 * **No aggregate.** One reviewed subject reports its own score, exactly as an upload of a single
 * skill does. Averaging belongs to copilot snapshots, where a parent and the agents it calls are
 * separately reviewed bots.
 *
 * Browser-safe. No `Buffer`, no `process`, no generated Dataverse client.
 */

import { createReviewJobPort } from '../dispatch/review-job-port';
import {
  detectDeclarativeAgent,
  type DetectedDeclarativeAgent,
} from '../harnesses/declarative-agent/da-detection';
import {
  reviewDeclarativeAgent,
  type DeclarativeAgentReviewOutcome,
} from '../harnesses/declarative-agent/da-review';
import type { EngineTransport } from '../contracts/transport';
import type { PriorAgentAttempt } from '../contracts/resume';
import type {
  AgentReviewProgress,
  AgentReviewStage,
  SnapshotProgressListener,
} from '../contracts/review-progress';

export interface DeclarativeAgentSnapshotRunOptions {
  /** Where the snapshot's rows are written. An upload has no source environment of its own. */
  transport: EngineTransport;
  /**
   * The package the author chose, unread.
   *
   * The `File` itself rather than this engine's `UploadedArtifact`, because ART's parser resolves
   * the manifest's internal references to find the declarative agent and its plugins — which a flat
   * file list cannot answer. Re-deriving one from the other would be a second implementation of the
   * archive format.
   */
  file: File;
  /**
   * The snapshot every job and review is stamped with.
   *
   * Required here, unlike the skill and agent runs, because the harness beneath requires it: the
   * snapshot id is half of the DA review's correlation id, and a request built without one comes
   * back with every rule rejected.
   */
  snapshotId: string;
  onProgress?: SnapshotProgressListener;
  /**
   * Called when the review finishes, so the host can persist before the run returns.
   *
   * Same contract as the skill run's `onSkillReviewed`. It matters less here — there is only one
   * subject, so there is no half-finished set to preserve — but keeping the shape identical is what
   * lets the three runs share one persistence object.
   */
  onDeclarativeAgentReviewed?: (
    agent: DetectedDeclarativeAgent,
    outcome: DeclarativeAgentReviewOutcome,
  ) => Promise<void> | void;
  /** What an earlier run of this snapshot already finished, keyed by subject id. */
  resume?: ReadonlyMap<string, PriorAgentAttempt>;
  signal?: AbortSignal;
}

export interface DeclarativeAgentSnapshotRunResult {
  /** The detected package. Absent when the upload was not a declarative agent. */
  agent?: DetectedDeclarativeAgent;
  outcome?: DeclarativeAgentReviewOutcome;
  error?: Error;
  /** Carried forward from an earlier run of this snapshot rather than reviewed again. */
  resumed?: { score: number | null; reviewId?: string };
  /**
   * Why nothing was reviewed, in the detector's words.
   *
   * An upload that is not a declarative agent package is a finished run with no subject, not a
   * thrown error: the dialog has a sentence to show, and the snapshot row it already created should
   * say why it is empty.
   */
  reason?: string;
  /**
   * The reviewed package's score, reported as-is.
   *
   * Null when nothing scored. "Not scored" and "scored zero" are different findings, and the card
   * reads one column for both.
   */
  score: number | null;
}

/**
 * Detect, review and record.
 *
 * Detection completes before the review starts, exactly as discovery does in the agent run, so the
 * dialog names the agent it is about to grade rather than filling in afterwards.
 */
export async function runDeclarativeAgentSnapshot(
  options: DeclarativeAgentSnapshotRunOptions,
): Promise<DeclarativeAgentSnapshotRunResult> {
  const {
    transport,
    file,
    snapshotId,
    onProgress,
    onDeclarativeAgentReviewed,
    resume,
    signal,
  } = options;

  let progress: AgentReviewProgress | undefined;

  const emit = (settled = false) =>
    onProgress?.({
      snapshotId,
      agents: progress ? [progress] : [],
      settled,
    });

  const update = (patch: Partial<AgentReviewProgress>) => {
    if (!progress) return;
    progress = { ...progress, ...patch };
    emit();
  };

  // ---- detection -------------------------------------------------------------------------

  const detected = await detectDeclarativeAgent(file);

  if (!detected.agent) {
    emit(true);
    return {
      ...(detected.reason ? { reason: detected.reason } : {}),
      score: null,
    };
  }

  const agent = detected.agent;
  const subjectId = agent.subjectId;

  progress = {
    agentId: subjectId,
    agentName: agent.displayName,
    // A package declares one agent. Nothing contains it and it contains no other subject, so it is
    // a parent at depth 0 — the same shape an uploaded skill takes.
    role: 'parent',
    outcome: 'pending',
    stage: 'parsing-configuration',
    detail: 'Reading the package',
  };
  emit();

  if (signal?.aborted) {
    update({ outcome: 'cancelled', detail: 'Cancelled' });
    emit(true);
    return { agent, error: new Error('Review cancelled'), score: null };
  }

  // ---- resume ----------------------------------------------------------------------------

  // A package this snapshot already reviewed is evidence, not work. Re-reviewing it would spend a
  // workflow run to recompute a number that is already saved and — because a review is graded at
  // the moment it runs — could return a different one, which would make a single snapshot describe
  // the same agent at two points in time.
  const prior = resume?.get(subjectId);
  if (prior?.status === 'succeeded') {
    update({
      outcome: 'succeeded',
      stage: 'saving-results' as AgentReviewStage,
      detail: 'Already reviewed in this snapshot',
      ...(prior.score === undefined ? {} : { score: prior.score }),
      ...(prior.jobId ? { jobId: prior.jobId } : {}),
    });
    emit(true);
    return {
      agent,
      resumed: {
        score: prior.score ?? null,
        ...(prior.reviewId ? { reviewId: prior.reviewId } : {}),
      },
      score: prior.score ?? null,
    };
  }

  // ---- review ----------------------------------------------------------------------------

  update({ outcome: 'running', stage: 'parsing-configuration', detail: 'Checking manifest health' });

  // One job port for this subject, so the job row carries this snapshot's id. Stamping is the only
  // thing that keeps a re-review's results from being collected onto the snapshot before it.
  const jobs = createReviewJobPort(transport, { snapshotId });

  try {
    const outcome = await reviewDeclarativeAgent({
      agent,
      jobs,
      snapshotId,
      // A job row from an interrupted run is almost certainly still executing: the flow runs on the
      // server and does not stop when the tab does. Attaching collects the results it has been
      // producing all along instead of paying for a second run of identical work.
      ...(prior?.jobId ? { existingJobId: prior.jobId } : {}),
      ...(signal ? { signal } : {}),
      onJobSubmitted: (jobId) => update({ jobId }),
      onProgress: (p) => update({ stage: p.stage, detail: p.detail }),
    });

    update({
      stage: 'saving-results' as AgentReviewStage,
      detail: 'Saving results',
      ...(outcome.score === null ? {} : { score: outcome.score }),
    });

    await onDeclarativeAgentReviewed?.(agent, outcome);

    update({ outcome: 'succeeded', detail: 'Review complete' });
    emit(true);
    return { agent, outcome, score: outcome.score };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    // The failure is reported against the agent it belongs to rather than thrown, so the snapshot
    // keeps a row saying what went wrong instead of ending with nothing recorded.
    update({
      outcome: signal?.aborted ? 'cancelled' : 'failed',
      detail: failure.message,
      error: failure.message,
    });
    emit(true);
    return { agent, error: failure, score: null };
  }
}
