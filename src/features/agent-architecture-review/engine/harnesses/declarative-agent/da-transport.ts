/**
 * The declarative-agent workflow transport — ART's DA review job, driven by this engine's job port.
 *
 * `evaluateDAWorkflowRequest` asks a `DAWorkflowTransport` exactly one question: send this request
 * to the workflow and bring back its outcomes. ART answers it with `executeDAReviewJob`, which
 * binds four generated Dataverse services. This module answers the same question with the engine's
 * own `ReviewJobPort`, so the corpus shape, the rule set and the rejection ladder stay ART's while
 * the I/O is ours. A DA review here is the same review, not a second opinion that resembles it.
 *
 * It is a sibling of the standard harness's submit-poll-read sequence, not a branch of it. A DA run
 * has one subject and six rules where a standard run has five units; the two share the job port,
 * which is the part worth sharing, rather than a code path that would have to fork on every line.
 *
 * ## The correlation id is the contract, and it has two ends
 *
 * `parseDAReviewJobRows` rejects any row whose `cat_correlationid` disagrees with the request it
 * was given, and it rejects per rule — a mismatch reads as "never evaluated", not as a pass. But
 * `createReviewJob` does not write the request's id verbatim: when the port carries a snapshot
 * stamp it *overwrites* that column with `snapshotId:botId`, so a re-review of one agent stays
 * separable from the original.
 *
 * Those two facts only coexist if the caller allocates the request's id in precisely that shape,
 * which is what {@link declarativeAgentCorrelationId} is for. Build a request with a random uuid
 * instead and every rule comes back rejected, with a job that succeeded and a review that reports
 * nothing — the quietest possible failure. `da-transport.test.ts` pins the equality against the
 * real port rather than leaving this comment to assert it.
 *
 * ## No availability pre-flight, deliberately
 *
 * ART calls `assertReviewWorkflowAvailable` before creating a job. That function reaches
 * `reviewWorkflowMetadata`, which imports two `src/generated/**` services, so it cannot cross the
 * `art-ports` seam without dragging generated Dataverse clients into this engine. It is also not
 * the house pattern: no harness in this app performs that pre-flight. An unreachable workflow
 * surfaces here the same way it surfaces for every other harness — `pollReviewJob` gives up at the
 * unclaimed-job window and throws `workflow-unavailable`, which is the degradation path the rest of
 * the engine is already built around.
 */

import type { ReviewJobPort } from '../../dispatch/review-job-port';
import {
  buildDAReviewJobCorpus,
  parseDAReviewJobRows,
  pollReviewJob,
  ReviewJobItemStatus,
  type DAReviewJobCorpus,
  type DAWorkflowRequest,
  type DAWorkflowTransport,
  type DAWorkflowTransportResult,
  type ReviewJobRow,
} from '../../scoring/art-ports';

/**
 * Names this app in the corpus the workflow receives.
 *
 * Both apps submit to the same workflow, and neither the job's harness column nor its bot id
 * distinguishes them any more, so this is the only field that records which app asked. The
 * workflow does not read it — it is declared nullable in the parse schema and no expression
 * references it — which is exactly why it is safe to set and why it must not become a routing key.
 */
const GENERATED_BY = 'Agent Review Center';

export interface DAWorkflowTransportOptions {
  /** This engine's Dataverse access. Stamped with the snapshot, which is what rewrites the id. */
  jobs: ReviewJobPort;
  /** A job already submitted for this subject, from the resume map. Skips creation. */
  existingJobId?: string;
  signal?: AbortSignal;
  /** Called once, with the id of a newly created job. Not called on resume. */
  onJobSubmitted?: (jobId: string) => void;
  onPoll?: (row: ReviewJobRow, elapsedMs: number) => void | Promise<void>;
}

/**
 * The correlation id a DA request must carry for its rows to be readable.
 *
 * Mirrors what `createReviewJob` recomputes from the snapshot stamp, so the overwrite is a no-op
 * and `parseDAReviewJobRows` matches every row it reads back.
 */
export function declarativeAgentCorrelationId(snapshotId: string, agentId: string): string {
  return `${snapshotId}:${agentId}`;
}

/**
 * Re-stamps a built request with the correlation id its rows will come back carrying.
 *
 * Takes the agent id from the request rather than deriving it, because the two DA identifiers are
 * not the same value and picking the wrong one fails silently. `buildDAWorkflowRequest` sets
 * `agent.id` to `daId` and falls back to `appId`; `getDAIdentifier` — the id a review is *stored*
 * under — prefers `appId` and falls back to a hash. A package carrying both therefore has two
 * identifiers, and only the one the corpus puts in `review.botId` is the one the job row is
 * stamped from. Reading it off the request is what keeps those two derivations from drifting.
 */
export function stampDACorrelation(
  request: DAWorkflowRequest,
  snapshotId: string,
): DAWorkflowRequest {
  return {
    ...request,
    correlationId: declarativeAgentCorrelationId(snapshotId, request.agent.id),
  };
}

/**
 * ART's DA corpus, with the two fields this app owns.
 *
 * `harness` selects `cat_harness = DeclarativeAgent`, a column the job writer already maps and the
 * workflow does not branch on — it exists so a future per-harness trigger can route on something
 * the Dataverse trigger can actually see, which is not true of anything inside the uploaded file.
 * Everything else is ART's, byte for byte, including the `cat_jobkind` the writer derives.
 */
export function buildArcDAReviewJobCorpus(request: DAWorkflowRequest): DAReviewJobCorpus {
  return {
    ...buildDAReviewJobCorpus(request),
    harness: 'DeclarativeAgent',
    generatedBy: GENERATED_BY,
  };
}

/** Binds a job port to the transport `evaluateDAWorkflowRequest` expects. */
export function createDAWorkflowTransport(
  options: DAWorkflowTransportOptions,
): DAWorkflowTransport {
  const { jobs, existingJobId, signal, onJobSubmitted, onPoll } = options;

  return async (request: DAWorkflowRequest): Promise<DAWorkflowTransportResult> => {
    signal?.throwIfAborted();

    const jobId = existingJobId ?? (await jobs.createReviewJob(buildArcDAReviewJobCorpus(request)));
    if (!existingJobId) onJobSubmitted?.(jobId);

    await pollReviewJob({
      getJob: () => jobs.getReviewJob(jobId),
      ...(signal ? { signal } : {}),
      ...(onPoll ? { onPoll } : {}),
      // Asked when the job reports Failed, and again when it was never claimed. A run that wrote
      // real rows before failing is worth reading; one that wrote nothing is not worth waiting for.
      hasSalvageableResults: async () => {
        const rows = await jobs.getReviewJobItemRows(jobId);
        return rows.some(
          (row) =>
            row.cat_itemstatus === ReviewJobItemStatus.Succeeded
            && Boolean(row.cat_resultjson?.trim()),
        );
      },
    });

    const parsed = parseDAReviewJobRows(request, await jobs.getReviewJobItemRows(jobId));

    return {
      response: {
        contractVersion: request.contractVersion,
        correlationId: request.correlationId,
        state: 'completed',
        outcomes: parsed.outcomes,
      },
      jobId,
      rejected: parsed.rejected,
    };
  };
}
