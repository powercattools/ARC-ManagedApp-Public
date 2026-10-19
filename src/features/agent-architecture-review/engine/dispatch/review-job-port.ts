/**
 * Dataverse access for the review job tables, as the ports ART's workflow provider asks for.
 *
 * This host reuses ART's contracts and polling, and new jobs are queued for ART's workflow like
 * every other harness. The transport binds to this app's environment rather than ART's generated
 * per-table services. Corpus contents are unchanged; the V3 runtime is not enabled here.
 *
 * ## Why the engine writes its own job rows
 *
 * `WorkflowReviewAiProviderCore` takes this port as a constructor argument, so the review that runs
 * here is ART's — only the I/O is ours. Supplying the port is also what makes a snapshot possible:
 * every job created through it can be stamped with the snapshot it belongs to, which a call into
 * ART's own service could not do.
 */

import type { EngineTransport } from '../contracts/transport';
import { normalizeArc2ReviewJob } from './ai-workflow-review-job';
import {
  isComponentRow,
  mapReviewJobItems,
  safeParse,
  REVIEW_JOB_ENTITY_SET,
  REVIEW_JOB_ITEM_ENTITY_SET,
  ReviewJobError,
  ReviewJobStatus,
  ReviewHarness,
  corpusKindToJobKind,
  type AgentComponentResult,
  type NodeKind,
  type ReviewJobItemRow,
  type ReviewJobRow,
  type ReviewJobSubmissionCorpus,
} from '../scoring/art-ports';

/** Columns read while polling. Never selects the file columns — the corpus is megabytes. */
const POLL_SELECT = [
  'cat_agentreviewjobid',
  'cat_correlationid',
  'cat_jobstatus',
  'cat_laststatus',
  'cat_errormessage',
  'cat_componentcount',
  'modifiedon',
].join(',');

/**
 * Columns read from each per-component result row.
 *
 * Must stay a superset of what ART's parsers read. `cat_componentid` in particular is not optional:
 * the standard parser checks it against the unit id it submitted, so omitting it does not degrade
 * the review — every unit fails identity and the whole run is rejected as malformed.
 *
 * `cat_correlationid` is the same kind of column for the declarative-agent parser, which compares
 * it against the request it built. An absent value reads as a mismatch, not as "unknown".
 */
const ITEM_SELECT = [
  'cat_agentreviewjobitemid',
  'cat_componentid',
  'cat_skillname',
  'cat_componentindex',
  'cat_correlationid',
  'cat_itemstatus',
  'cat_resultjson',
  'cat_errormessage',
  'createdon',
].join(',');

/** The engine's own port shape, structurally identical to ART's `WorkflowJobPort`. */
export interface ReviewJobPort {
  createReviewJob(corpus: ReviewJobSubmissionCorpus): Promise<string>;
  getReviewJob(jobId: string): Promise<ReviewJobRow>;
  getReviewJobResults(jobId: string): Promise<AgentComponentResult[]>;
  /** The same child rows, unmapped — the standard projection matches them to the corpus itself. */
  getReviewJobItemRows(jobId: string): Promise<ReviewJobItemRow[]>;
  getAgentLevelResult(jobId: string, index: number): Promise<unknown | null>;
  countCompletedComponents(jobId: string): Promise<number | undefined>;
}

/** Extra columns this engine stamps on a job row that ART's own service has no reason to write. */
export interface SnapshotStamp {
  /**
   * The snapshot this job belongs to.
   *
   * The source agent identity is carried here as well as on `cat_botid`, because one snapshot can
   * review the same agent more than once and `cat_botid` alone cannot separate those runs.
   *
   * Carried in `cat_correlationid` as `snapshotId:agentId`, not as a lookup. `cat_agentreviewjob`
   * belongs to the Agent Review Tool's solution and has no snapshot column - writing one is an
   * undeclared-property 400 that silently downgrades the review to deterministic findings. The
   * correlation column exists for exactly this join and needs no schema change to either product.
   */
  snapshotId?: string;
}

function guard(value: string, what: string): string {
  if (value.includes("'")) throw new ReviewJobError('workflow-failed', `${what} contains a quote.`);
  return value;
}

/**
 * Build the job port for one environment.
 *
 * Job rows always belong to the environment hosting this app, never the reviewed agent's — the
 * transport enforces that by routing on table name, so nothing here has to know.
 */
export function createReviewJobPort(
  transport: EngineTransport,
  stamp: SnapshotStamp = {},
): ReviewJobPort {
  /**
   * Read the child rows for one job, oldest first.
   *
   * A component can legitimately have more than one row — a resubmitted run, or a retried loop
   * iteration whose create succeeded before a later action failed — so the order is what lets both
   * readers below decide which row wins.
   */
  const readItemRows = async (jobId: string): Promise<ReviewJobItemRow[]> => {
    const filter = `_cat_jobid_value eq ${guard(jobId, 'Job id')}`;
    const rows = await transport.rows(
      `${REVIEW_JOB_ITEM_ENTITY_SET}?$select=${ITEM_SELECT}` +
        `&$filter=${encodeURIComponent(filter)}` +
        `&$orderby=${encodeURIComponent('cat_componentindex asc,createdon asc')}`,
    );
    return rows as unknown as ReviewJobItemRow[];
  };

  return {
    /**
     * Creates a Queued row, uploads the corpus, then writes Queued again.
     *
     * The order matters and is not arbitrary. A file cannot be attached to a row that does not exist
     * yet, so create-then-upload is forced. ART's trigger is
     * `cat_jobstatus eq 1 and cat_inputfile_name ne null`, so the row stays invisible to the flow
     * until the corpus lands however early the status is written; the final status attribute update
     * is the handoff, even though the value is unchanged.
     *
     * The row id is generated here rather than read back from the response. Dataverse accepts a
     * client-supplied primary key, and supplying one means the id is known before the request is
     * sent — so a response that is lost in flight leaves a row this code can still find, instead of
     * an orphan that will be reviewed and never collected.
     */
    async createReviewJob(corpus: ReviewJobSubmissionCorpus): Promise<string> {
      const jobId = crypto.randomUUID();
      // A standard corpus counts review units, not components; a copilot one counts components.
      const componentCount = corpus.review.componentCount
        ?? corpus.components?.length
        ?? corpus.standardReview?.reviewUnits.length
        ?? 0;
      // A `StandardReview` corpus is by definition the standard harness, so the column is filled
      // from the discriminator rather than left unset.
      const harness = corpus.harness
        ?? (corpus.jobKind === 'StandardReview' ? 'Standard' : undefined);

      // 1. Queue for ART. The file clause in its trigger keeps the row dormant until step 2.
      const created = await transport.request('POST', REVIEW_JOB_ENTITY_SET, {
        cat_agentreviewjobid: jobId,
        cat_name: `${corpus.review.botName} - ${componentCount} components`,
        cat_jobstatus: ReviewJobStatus.Queued,
        cat_jobkind: corpusKindToJobKind(corpus.jobKind),
        ...(harness ? { cat_harness: ReviewHarness[harness] } : {}),
        // `snapshotId:agentId`, matching `cat_architecturereviewagent.cat_correlationid`, so a
        // re-review of the same agent is separable from the original. The snapshot cannot be a
        // lookup here: this table ships with the Agent Review Tool and has no snapshot column.
        cat_correlationid: stamp.snapshotId
          ? `${stamp.snapshotId}:${corpus.review.botId}`
          : corpus.review.correlationId,
        cat_botid: corpus.review.botId,
        cat_botname: corpus.review.botName,
        cat_componentcount: componentCount,
      });
      if (created.status >= 300) {
        throw new ReviewJobError('workflow-failed', `Create review job failed (HTTP ${created.status}).`);
      }

      // 2. Attach the corpus.
      try {
        await transport.putFile(
          REVIEW_JOB_ENTITY_SET,
          jobId,
          'cat_inputfile',
          'review-corpus.json',
          new TextEncoder().encode(JSON.stringify(corpus)),
        );
      } catch (error) {
        throw new ReviewJobError(
          'workflow-failed',
          `Corpus upload failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // 3. Include the status attribute again: Dataverse update triggers do not require a new value.
      try {
        await transport.patch(`${REVIEW_JOB_ENTITY_SET}(${jobId})`, {
          cat_jobstatus: ReviewJobStatus.Queued,
        });
      } catch (error) {
        throw new ReviewJobError(
          'workflow-failed',
          `Could not queue the review job: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      return jobId;
    },

    async getReviewJob(jobId: string): Promise<ReviewJobRow> {
      const row = await transport.get(
        `${REVIEW_JOB_ENTITY_SET}(${guard(jobId, 'Job id')})?$select=${POLL_SELECT}`,
      );
      return normalizeArc2ReviewJob(row);
    },

    /**
     * Reads the per-component results the workflow wrote as child rows.
     *
     * A component can legitimately have more than one row — a resubmitted run, or a retried loop
     * iteration whose create succeeded before a later action failed — so rows are ordered oldest
     * first and {@link mapReviewJobItems} keeps the newest usable one per component.
     *
     * `node` is forwarded rather than defaulted here: it names the rules a failed
     * component reports as unassessed, and the two skill harnesses do not share a set.
     */
    async getReviewJobResults(jobId: string, node?: NodeKind): Promise<AgentComponentResult[]> {
      return mapReviewJobItems(await readItemRows(jobId), node);
    },

    /**
     * The same rows without {@link mapReviewJobItems}.
     *
     * The standard projection matches rows to review units by component index against the corpus it
     * submitted, so it needs the rows as written. Collapsing them to one result per component first
     * would discard the index it matches on.
     */
    async getReviewJobItemRows(jobId: string): Promise<ReviewJobItemRow[]> {
      return readItemRows(jobId);
    },

    /**
     * Reads the raw payload an agent-level stage wrote, or null when it is absent.
     *
     * A missing row is not an error: the node may not exist in this environment's workflow yet, or
     * it may have failed while the per-component results succeeded. ART falls back to the AI Prompt
     * path in that case, which is why this returns null rather than throwing.
     */
    async getAgentLevelResult(jobId: string, index: number): Promise<unknown | null> {
      const filter = `_cat_jobid_value eq ${guard(jobId, 'Job id')} and cat_componentindex eq ${index}`;
      try {
        const rows = await transport.rows(
          `${REVIEW_JOB_ITEM_ENTITY_SET}?$select=${ITEM_SELECT}` +
            `&$filter=${encodeURIComponent(filter)}` +
            `&$orderby=${encodeURIComponent('createdon asc')}`,
        );
        let latest: unknown | null = null;
        for (const row of rows as unknown as ReviewJobItemRow[]) {
          const parsed = safeParse(row.cat_resultjson ?? '');
          if (parsed && typeof parsed === 'object') latest = parsed;
        }
        return latest;
      } catch {
        return null;
      }
    },

    /**
     * Counts the distinct components the workflow has finished so far.
     *
     * Drives real "n of m" progress. The in-loop status ping tells the client that something
     * finished but not how many: parallel iterations overwrite each other's value, so it races by
     * design. The child rows do not — each iteration inserts its own — so counting them is the only
     * accurate measure.
     *
     * Counts distinct component indexes rather than raw rows, because a retried iteration can leave
     * more than one row for the same component and would otherwise report more progress than was
     * actually made. Agent-level and per-resource rows are excluded for the same reason: including
     * them reports 13 of 12.
     */
    async countCompletedComponents(jobId: string): Promise<number | undefined> {
      const filter = `_cat_jobid_value eq ${guard(jobId, 'Job id')}`;
      try {
        const rows = await transport.rows(
          `${REVIEW_JOB_ITEM_ENTITY_SET}?$select=cat_agentreviewjobitemid,cat_componentindex` +
            `&$filter=${encodeURIComponent(filter)}`,
        );
        const seen = new Set<number | string>();
        for (const row of rows as unknown as ReviewJobItemRow[]) {
          if (!isComponentRow(row)) continue;
          seen.add(row.cat_componentindex ?? `row:${row.cat_agentreviewjobitemid}`);
        }
        return seen.size;
      } catch {
        // Progress is cosmetic; the job row is what decides the outcome.
        return undefined;
      }
    },
  };
}
