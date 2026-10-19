/**
 * Drive one snapshot of an uploaded artifact: detect what is in it, review each skill, record them.
 *
 * A sibling of `runSnapshot`, not a branch of it (`harness-skill.md` §8). `runSnapshot` starts from a
 * bot id and expands a graph; an upload has neither, and passing a synthetic id would drive it into
 * a `bots` lookup that must fail. Everything after the subject is known is shared: the same progress
 * contract, the same per-item job port, the same incremental persistence callback, the same resume
 * map.
 *
 * ## What is deliberately absent
 *
 * **No runtime analysis.** A skill has no conversations of its own — it runs inside whichever agent
 * loads it — so there is nothing to read (§5).
 *
 * **No aggregate.** Each skill carries its own score and the snapshot reports it as-is — the same
 * rule the standard harness follows. Averaging belongs to copilot snapshots, where a parent and the
 * agents it calls are separately reviewed bots (§7).
 *
 * Browser-safe. No `Buffer`, no `process`, no generated Dataverse client.
 */

import { createReviewJobPort } from '../dispatch/review-job-port';
import { detectSkills, type DetectedSkill } from '../harnesses/skill/skill-detection';
import { reviewSkillArtifact, type SkillReviewOutcome } from '../harnesses/skill/skill-review';
import { DEFAULT_CONCURRENCY, pooled } from './pooled';
import type { EngineTransport } from '../contracts/transport';
import type { PriorAgentAttempt } from '../contracts/resume';
import type {
  PredictTransport,
  ReviewModelIds,
  TargetRuntime,
  UploadedArtifact,
} from '../scoring/art-ports';
import type {
  AgentReviewProgress,
  AgentReviewStage,
  SnapshotProgressListener,
} from '../contracts/review-progress';

export interface UploadSnapshotRunOptions {
  /** Where the snapshot's rows are written. An upload has no source environment of its own. */
  transport: EngineTransport;
  /** Already read from the file the author chose — this module does no I/O of its own. */
  artifact: UploadedArtifact;
  /**
   * The runtimes the author ticked.
   *
   * Never detected. A SKILL.md carries no marker naming its target platform, so inferring one would
   * silently pick a rubric on the author's behalf (§9).
   */
  runtimes: TargetRuntime[];
  /** The snapshot row every job and review is stamped with. */
  snapshotId?: string;
  predict: PredictTransport;
  onProgress?: SnapshotProgressListener;
  /**
   * Called as each skill finishes, so the host can persist incrementally.
   *
   * Same contract as the agent run's `onAgentReviewed`: a browser that closes half way leaves
   * durable evidence for the skills that finished rather than discarding everything.
   */
  onSkillReviewed?: (skill: DetectedSkill, outcome: SkillReviewOutcome) => Promise<void> | void;
  /** What an earlier run of this snapshot already finished, keyed by subject id. */
  resume?: ReadonlyMap<string, PriorAgentAttempt>;
  concurrency?: number;
  modelIds?: ReviewModelIds;
  signal?: AbortSignal;
}

/** One skill's place in the finished snapshot. */
export interface SkillRunResult {
  skill: DetectedSkill;
  outcome?: SkillReviewOutcome;
  error?: Error;
  /** Carried forward from an earlier run of this snapshot rather than reviewed again. */
  resumed?: { score: number | null; reviewId?: string };
}

export interface UploadSnapshotRunResult {
  skills: SkillRunResult[];
  /**
   * Why nothing was reviewed, when detection found nothing reviewable.
   *
   * An unreviewable upload is a finished run with no skills, not a thrown error: the dialog has a
   * sentence to show, and the snapshot row it already created should say why it is empty.
   */
  reason?: string;
  /**
   * The reviewed artifact's score, reported as-is.
   *
   * An upload is one reviewed thing, so this is simply its score — the same rule the standard
   * harness follows, and for the same reason: there is nothing to aggregate. Averaging is a
   * copilot-harness rule, where a snapshot spans several separately reviewed bots.
   *
   * Null when nothing scored. "Not scored" and "scored zero" are different findings, and the card
   * reads one column for both.
   */
  score: number | null;
}

/**
 * Detect, review and record.
 *
 * Detection completes before any review starts, exactly as discovery does in the agent run, so the
 * dialog's total is known the moment it appears rather than growing while the user watches it.
 */
export async function runUploadSnapshot(
  options: UploadSnapshotRunOptions,
): Promise<UploadSnapshotRunResult> {
  const {
    transport,
    artifact,
    runtimes,
    snapshotId,
    predict,
    onProgress,
    onSkillReviewed,
    resume,
    concurrency = DEFAULT_CONCURRENCY,
    modelIds,
    signal,
  } = options;

  const progress = new Map<string, AgentReviewProgress>();
  const order: string[] = [];

  const emit = (settled = false) =>
    onProgress?.({
      ...(snapshotId ? { snapshotId } : {}),
      agents: order.map((id) => progress.get(id)!),
      settled,
    });

  const update = (subjectId: string, patch: Partial<AgentReviewProgress>) => {
    const current = progress.get(subjectId);
    if (!current) return;
    progress.set(subjectId, { ...current, ...patch });
    emit();
  };

  // ---- detection -------------------------------------------------------------------------

  const detected = detectSkills(artifact);

  for (const skill of detected.skills) {
    order.push(skill.identity.subjectId);
    progress.set(skill.identity.subjectId, {
      agentId: skill.identity.subjectId,
      agentName: skill.identity.displayName,
      // Every skill in an upload is a subject in its own right. None contains another, so none is a
      // parent of another, and all sit at depth 0.
      role: 'parent',
      outcome: 'pending',
      stage: 'parsing-configuration',
      detail: 'Identifying the artifact type',
    });
  }
  emit(detected.skills.length === 0);

  if (detected.skills.length === 0) {
    return {
      skills: [],
      ...(detected.reason ? { reason: detected.reason } : {}),
      score: null,
    };
  }

  // ---- review ----------------------------------------------------------------------------

  const results = await pooled<SkillRunResult>(
    detected.skills.map((skill) => async () => {
      const subjectId = skill.identity.subjectId;

      if (signal?.aborted) {
        update(subjectId, { outcome: 'cancelled', detail: 'Cancelled' });
        return { skill, error: new Error('Review cancelled') };
      }

      // A skill this snapshot already reviewed is evidence, not work. Re-reviewing it would spend a
      // workflow run to recompute a number that is already saved and — because a review is graded at
      // the moment it runs — could return a different one, which would make a single snapshot
      // describe the same skill at two points in time.
      const prior = resume?.get(subjectId);
      if (prior?.status === 'succeeded') {
        update(subjectId, {
          outcome: 'succeeded',
          stage: 'saving-results' as AgentReviewStage,
          detail: 'Already reviewed in this snapshot',
          ...(prior.score === undefined ? {} : { score: prior.score }),
          ...(prior.jobId ? { jobId: prior.jobId } : {}),
        });
        return {
          skill,
          resumed: {
            score: prior.score ?? null,
            ...(prior.reviewId ? { reviewId: prior.reviewId } : {}),
          },
        };
      }

      update(subjectId, {
        outcome: 'running',
        stage: 'parsing-configuration',
        detail: 'Reading the uploaded files',
      });

      // One job port per skill, so every job row carries this snapshot's id. Stamping is the only
      // thing that keeps a re-review's results from being collected onto the snapshot before it.
      const jobs = createReviewJobPort(transport, {
        ...(snapshotId ? { snapshotId } : {}),
      });

      try {
        const outcome = await reviewSkillArtifact({
          artifact: skill.artifact,
          runtimes,
          identity: skill.identity,
          jobs,
          predict,
          // A job row from an interrupted run is almost certainly still executing: the flow runs on
          // the server and does not stop when the tab does. Attaching collects the results it has
          // been producing all along instead of paying for a second run of identical work.
          ...(prior?.jobId ? { existingJobId: prior.jobId } : {}),
          ...(modelIds ? { modelIds } : {}),
          ...(signal ? { signal } : {}),
          onJobSubmitted: (jobId) => update(subjectId, { jobId }),
          onProgress: (p) => update(subjectId, { stage: p.stage, detail: p.detail }),
        });

        update(subjectId, {
          stage: 'saving-results' as AgentReviewStage,
          detail: 'Saving results',
          ...(outcome.score === null ? {} : { score: outcome.score }),
        });

        await onSkillReviewed?.(skill, outcome);

        update(subjectId, { outcome: 'succeeded', detail: 'Review complete' });
        return { skill, outcome };
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        // One skill failing does not fail the snapshot, for the same reason one agent failing does
        // not: the rest are still worth grading, and the failure is reported against the skill it
        // belongs to rather than silently lowering anything.
        update(subjectId, {
          outcome: signal?.aborted ? 'cancelled' : 'failed',
          detail: failure.message,
          error: failure.message,
        });
        return { skill, error: failure };
      }
    }),
    Math.max(1, concurrency),
  );

  emit(true);

  const scores = results
    .map((result) => (result.resumed ? result.resumed.score : result.outcome?.score))
    .filter((score): score is number => typeof score === 'number');

  // The reviewed artifact's score, unchanged. Should ART ever return several skills from one
  // upload there is no single score to report and none is manufactured — each skill's own score is
  // already on its own row, which is where a reader can act on it.
  return {
    skills: results,
    score: scores.length === 1 ? scores[0]! : null,
  };
}
