/**
 * What a previous run of the same snapshot already achieved.
 *
 * A snapshot can take minutes, and the assembly half of a review runs in the browser. Closing the
 * tab therefore stops the run even though the workflow and the transcript analysis it queued keep
 * going on the server. Re-running the saved snapshot is the recovery path, and this is what makes
 * that second run a resume rather than a repeat: agents that already finished are carried forward
 * instead of reviewed again, and an agent whose job is still executing is re-attached to it rather
 * than costing a second flow run.
 *
 * Lives in `contracts` so the persistence layer that reads these rows and the orchestrator that
 * acts on them can agree on the shape without importing each other.
 *
 * Browser-safe. No `Buffer`, no `process`, no generated Dataverse client.
 */

/** Mirrors `cat_architecturereviewagent.cat_reviewstatus`. */
export type PriorReviewStatus = 'pending' | 'running' | 'succeeded' | 'failed';

/** One agent's row from an earlier run of this snapshot. */
export interface PriorAgentAttempt {
  /**
   * The existing `cat_architecturereviewagent` row.
   *
   * Reused rather than replaced: the row is keyed by `snapshotId:agentId`, so a resumed run that
   * POSTed again would leave two rows claiming to be the same agent in the same snapshot, and
   * `linkRuntimeJob` — which resolves an agent by correlation id and takes the first match — would
   * then attach runtime evidence to whichever one Dataverse happened to return.
   *
   * Absent when the attempt was recovered from a job row rather than an agent row. An agent row is
   * only written once its review has been collected, so a run interrupted mid-flight leaves a
   * durable job and no row at all; the resumed run writes the row when it finishes.
   */
  rowId?: string;
  status: PriorReviewStatus;
  /** `cat_agentreviews` row holding the finished review, when there is one. */
  reviewId?: string;
  /**
   * `cat_agentreviewjobs` row this agent's AI stages were submitted to.
   *
   * Present without a `reviewId` means the flow was queued but the browser closed before its
   * results were collected. That job is very likely still running, so a resumed run attaches to it.
   */
  jobId?: string;
  /** Cached score from the referenced review, so a carried-forward agent still counts in the rollup. */
  score?: number;
}
