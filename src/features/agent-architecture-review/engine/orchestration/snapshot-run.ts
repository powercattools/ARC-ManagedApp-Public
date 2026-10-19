/**
 * Drive one snapshot: capture an agent and everything it calls, review them all, roll the scores up.
 *
 * A snapshot is the unit the product compares over time, so this module owns the two properties that
 * make comparison meaningful. Every agent in a snapshot is reviewed under the same rubric at the
 * same moment, and every review it produces is stamped with the snapshot it belongs to — without
 * that stamp a re-review is indistinguishable from the original, because both carry the same agent
 * id.
 *
 * A run may also be a resume. The assembly and scoring half runs in the browser, so closing the tab
 * stops it even though the workflow runs it queued keep going on the server; re-running the saved
 * snapshot is the recovery path. Given what an earlier run recorded, this module carries finished
 * agents forward untouched and re-attaches the rest to the jobs still executing for them, so the
 * second run costs only the work the first did not finish.
 *
 * Browser-safe. No `Buffer`, no `process`, no generated Dataverse client.
 */

import { reviewAgent, type HarnessReviewOutcome } from '../harnesses/harness-dispatch';
import { createReviewJobPort } from '../dispatch/review-job-port';
import { expandAgentGraph, type AgentWorkItem, type UnresolvedAgent } from './agent-graph';
import { DEFAULT_CONCURRENCY, pooled } from './pooled';
import type { EngineTransport } from '../contracts/transport';
import type { PredictTransport, ReviewModelIds } from '../scoring/art-ports';
import type { PriorAgentAttempt } from '../contracts/resume';
import type {
  AgentReviewProgress,
  AgentReviewStage,
  SnapshotProgressListener,
} from '../contracts/review-progress';

/**
 * How many agents may be in flight at once.
 *
 * Shared with the upload run, so the two entry points cannot drift apart. See `pooled.ts`.
 */

export interface SnapshotRunOptions {
  /** Bound to the environment that authored the agents. Job rows still land in this app's own. */
  transport: EngineTransport;
  /** Agent the snapshot is taken of. Its connected agents are discovered, not listed. */
  parentBotId: string;
  /** The snapshot row every job and review is stamped with. */
  snapshotId?: string;
  predict: PredictTransport;
  /**
   * Prompt ids resolved for the environment hosting this app.
   *
   * Omitted falls back to ART's compiled-in GUIDs, which only resolve in the environment they were
   * authored in — see `dispatch/model-catalog.ts`.
   */
  modelIds?: ReviewModelIds;
  onProgress?: SnapshotProgressListener;
  /**
   * Called as each agent finishes, so the host can persist incrementally.
   *
   * A snapshot of several agents can run for minutes. Persisting per agent means a browser that
   * closes half way leaves durable evidence for the agents that finished, rather than discarding
   * everything up to that point.
   */
  onAgentReviewed?: (item: AgentWorkItem, outcome: HarnessReviewOutcome) => Promise<void> | void;
  /**
   * What an earlier run of this same snapshot already finished, keyed by agent id.
   *
   * Turns a repeat into a resume. An agent that already succeeded is carried forward with its
   * stored score instead of reviewed a second time, and an agent whose workflow job was queued but
   * never collected is re-attached to that job rather than being given a new one — the flow is very
   * likely still running on the server, and submitting again would pay for it twice and discard the
   * results of the first.
   */
  resume?: ReadonlyMap<string, PriorAgentAttempt>;
  concurrency?: number;
  maxDepth?: number;
  signal?: AbortSignal;
}

/** One agent's place in the finished snapshot. */
export interface AgentRunResult {
  item: AgentWorkItem;
  outcome?: HarnessReviewOutcome;
  error?: Error;
  /**
   * Carried forward from an earlier run of this snapshot rather than reviewed again.
   *
   * Distinct from `outcome` because there is no fresh review to persist — the rows already exist —
   * but the agent still counts towards the snapshot's rollup and its completion total.
   */
  resumed?: { score: number | null; reviewId?: string };
}

export interface SnapshotRunResult {
  agents: AgentRunResult[];
  unresolved: UnresolvedAgent[];
  /**
   * Snapshot score: the mean of every agent that produced one.
   *
   * Null when no agent did. A snapshot where the rubric could not score anything must not report
   * zero — zero is a real score that means "scored, and bad", and the two have to stay
   * distinguishable.
   */
  score: number | null;
}

/**
 * Capture, review and roll up.
 *
 * Discovery completes before any review starts. The alternative — reviewing the parent while its
 * children are still being found — would report a total that grows while the user watches it, and
 * would make "how far through am I" unanswerable. Capture is Dataverse reads and takes seconds; the
 * workflow is what takes minutes, and that half is fully parallel.
 */
export async function runSnapshot(options: SnapshotRunOptions): Promise<SnapshotRunResult> {
  const {
    transport,
    parentBotId,
    snapshotId,
    predict,
    modelIds,
    onProgress,
    onAgentReviewed,
    resume,
    concurrency = DEFAULT_CONCURRENCY,
    maxDepth,
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

  const update = (agentId: string, patch: Partial<AgentReviewProgress>) => {
    const current = progress.get(agentId);
    if (!current) return;
    progress.set(agentId, { ...current, ...patch });
    emit();
  };

  // ---- discovery -------------------------------------------------------------------------

  const graph = await expandAgentGraph(transport, parentBotId, {
    ...(maxDepth === undefined ? {} : { maxDepth }),
    ...(signal ? { signal } : {}),
    onDiscovered: (item) => {
      order.push(item.agentId);
      progress.set(item.agentId, {
        agentId: item.agentId,
        agentName: item.agentName,
        role: item.role,
        outcome: 'pending',
        stage: 'capturing',
        detail:
          item.role === 'parent'
            ? 'Reading agent configuration'
            : `Found connected agent ${item.agentName}`,
      });
      emit();
    },
  });

  // ---- review ----------------------------------------------------------------------------

  const results = await pooled<AgentRunResult>(
    graph.items.map((item) => async () => {
      if (signal?.aborted) {
        update(item.agentId, { outcome: 'cancelled', detail: 'Cancelled' });
        return { item, error: new Error('Review cancelled') };
      }

      // An agent this snapshot already reviewed is evidence, not work. Reviewing it again would
      // spend a workflow run to recompute a number that is already saved, and — because a review is
      // graded at the moment it runs — could return a different one, which would make a single
      // snapshot describe the same agent at two points in time.
      const prior = resume?.get(item.agentId);
      if (prior?.status === 'succeeded') {
        update(item.agentId, {
          outcome: 'succeeded',
          stage: 'saving-results' as AgentReviewStage,
          detail: 'Already reviewed in this snapshot',
          ...(prior.score === undefined ? {} : { score: prior.score }),
          ...(prior.jobId ? { jobId: prior.jobId } : {}),
        });
        return {
          item,
          resumed: {
            score: prior.score ?? null,
            ...(prior.reviewId ? { reviewId: prior.reviewId } : {}),
          },
        };
      }

      update(item.agentId, {
        outcome: 'running',
        stage: 'parsing-configuration',
        detail: 'Parsing configuration',
      });

      // One job port per agent, so every job row carries this snapshot's id. Sharing a port would
      // still work, but stamping is the only thing that keeps a re-review's results from being
      // collected onto the snapshot that came before it.
      const jobs = createReviewJobPort(transport, {
        ...(snapshotId ? { snapshotId } : {}),
      });

      try {
        const outcome = await reviewAgent({
          capture: item.capture,
          jobs,
          predict,
          ...(modelIds ? { modelIds } : {}),
          // A job row from an interrupted run is almost certainly still executing: the flow runs on
          // the server and does not stop when the tab does. Attaching collects the results it has
          // been producing all along instead of paying for a second run of identical work.
          ...(prior?.jobId ? { existingJobId: prior.jobId } : {}),
          ...(signal ? { signal } : {}),
          onJobSubmitted: (jobId) => update(item.agentId, { jobId }),
          onProgress: (p) =>
            update(item.agentId, {
              stage: p.stage,
              detail: p.detail,
              ...(p.componentCount === undefined ? {} : { componentCount: p.componentCount }),
              ...(p.completedComponents === undefined
                ? {}
                : { completedComponents: p.completedComponents }),
            }),
        });

        update(item.agentId, {
          stage: 'saving-results' as AgentReviewStage,
          detail: 'Saving results',
          ...(outcome.score === null ? {} : { score: outcome.score }),
        });

        await onAgentReviewed?.(item, outcome);

        update(item.agentId, { outcome: 'succeeded', detail: 'Review complete' });
        return { item, outcome };
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        // One agent failing does not fail the snapshot. A parent whose child could not be reviewed
        // is still worth grading, and the failure is reported against that child rather than
        // silently lowering the parent's score.
        update(item.agentId, {
          outcome: signal?.aborted ? 'cancelled' : 'failed',
          detail: failure.message,
          error: failure.message,
        });
        return { item, error: failure };
      }
    }),
    Math.max(1, concurrency),
  );

  emit(true);

  const scored = results
    .map((result) => (result.resumed ? result.resumed.score : result.outcome?.score))
    .filter((score): score is number => typeof score === 'number');

  return {
    agents: results,
    unresolved: graph.unresolved,
    score: scored.length
      ? Math.round(scored.reduce((total, score) => total + score, 0) / scored.length)
      : null,
  };
}
