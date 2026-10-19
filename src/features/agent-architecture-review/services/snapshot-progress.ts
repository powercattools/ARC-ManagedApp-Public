/**
 * What a snapshot's own rows say about its progress.
 *
 * The snapshot page used to read this from the orchestration record the POC dispatcher maintained.
 * The engine keeps no such record: `cat_architecturereviewagent` already holds one row per agent
 * with its status and the identifiers of everything it produced, and the runtime jobs are queryable
 * by snapshot. Deriving progress from those two is the same information without a third copy of it
 * that can disagree with them.
 */

import { artService } from './art-service';
import { createConnectorTransport } from './connector-transport';
import { runtimeService } from './runtime-service';
import { RuntimeJobStatus, type RuntimeJob } from '../models/runtime';
import type { AssessmentProgress, OrchestrationProgress } from '../models/orchestration';
import { AGENT_SET } from '../engine/persistence/schema/architecture-review-agent.ts';

/** Mirrors the option set written by `snapshot-persistence.ts`. */
const REVIEW_STATUS: Record<number, AssessmentProgress['status']> = {
  1: 'pending',
  2: 'active',
  3: 'succeeded',
  4: 'failed',
};

/**
 * Reasons an analysis ended with nothing to report rather than in error.
 *
 * A snapshot over an agent nobody used is a complete snapshot: it says the agent has no runtime
 * evidence. Reporting that as a failure would ask the user to fix something that is not broken.
 */
const NO_DATA_KINDS = new Set(['no-transcripts', 'recording-off', 'no-agent', 'other-environment']);

/** Identities in an `OrchestrationProgress` are compared verbatim, so they are stored lower-cased. */
function identity(value: string | undefined): string {
  return value?.toLowerCase() ?? '';
}

function runtimeStatus(job: RuntimeJob): AssessmentProgress['status'] {
  if (job.status === RuntimeJobStatus.Failed) {
    return job.errorKind && NO_DATA_KINDS.has(job.errorKind) ? 'no-data' : 'failed';
  }
  if (job.status !== RuntimeJobStatus.Succeeded) return 'active';
  return job.transcriptsProcessed > 0 ? 'succeeded' : 'no-data';
}

interface AgentRow {
  cat_agentid?: string;
  cat_agentname?: string;
  cat_reviewstatus?: number | string;
  cat_agentreviewid?: string;
  cat_agentreviewjobid?: string;
  cat_errormessage?: string;
  modifiedon?: string;
}

const SELECT = [
  'cat_agentid',
  'cat_agentname',
  'cat_reviewstatus',
  'cat_agentreviewid',
  'cat_agentreviewjobid',
  'cat_errormessage',
  'modifiedon',
].join(',');

/** The transcript window a snapshot was taken over, which bounds what runtime analysis could find. */
export interface TranscriptWindow {
  start?: string;
  end?: string;
}

/**
 * How long after the last review lands the queueing step is still assumed to be in flight.
 *
 * Runtime analysis is queued in the same browser turn that finishes the reviews, so for a few
 * seconds a snapshot legitimately has settled reviews and no runtime rows. Polling every five
 * seconds, a minute is many chances to see the rows appear before any conclusion is drawn.
 */
const QUEUEING_GRACE_MS = 60_000;

/**
 * Whether runtime evidence can still arrive for a snapshot that has none.
 *
 * The absence of runtime rows is ambiguous. Either the queueing step has not run yet, or it ran and
 * every agent was skipped because there was nothing to analyse - and in that case no row will ever
 * appear. Reading the second case as "still running" left a finished snapshot polling forever and
 * reporting `running` while listing every assessment as succeeded, which is what a review of three
 * agents with no transcripts in range did.
 *
 * `preflight` is the same authority `start` consults before creating a job, so asking it answers the
 * question instead of guessing. A preflight that throws is treated as "nothing coming" for the same
 * reason: `startForAgents` would have caught that failure and queued nothing either.
 */
async function runtimeStillExpected(
  agents: readonly AgentRow[],
  window: TranscriptWindow | undefined,
): Promise<boolean> {
  const verdicts = await Promise.all(
    agents
      .filter(row => row.cat_agentid)
      .map(row => runtimeService
        .preflight(row.cat_agentid!, undefined, { start: window?.start, end: window?.end })
        .then(verdict => verdict.canRun)
        .catch(() => false)),
  );
  return verdicts.some(Boolean);
}

/** Most recent edit across the agent rows, used only to tell a race apart from a settled snapshot. */
function lastTouched(agents: readonly AgentRow[]): number {
  return agents.reduce((newest, row) => {
    const at = row.modifiedon ? Date.parse(row.modifiedon) : Number.NaN;
    return Number.isNaN(at) ? newest : Math.max(newest, at);
  }, 0);
}

/**
 * Read one snapshot's progress, or `undefined` when the engine has not written anything for it.
 *
 * `undefined` is meaningful: it is what tells the page the snapshot was saved but never run, so it
 * can offer to run that same saved snapshot rather than leaving the user to create another.
 *
 * The agent rows are read through the connector rather than a generated service, because
 * `cat_architecturereviewagent` is written by the engine over the same transport and adding it as a
 * second, generated data source would give one table two clients that can drift apart.
 */
export async function snapshotProgress(
  snapshotId: string,
  window?: TranscriptWindow,
): Promise<OrchestrationProgress | undefined> {
  const context = await artService.linkContext();
  if (!context.organizationUrl) return undefined;
  const transport = createConnectorTransport(context.organizationUrl);

  const [agents, runtimeJobs] = await Promise.all([
    transport.rows(`${AGENT_SET}?$select=${SELECT}&$filter=_cat_resultid_value eq ${snapshotId}`, 500) as Promise<AgentRow[]>,
    // Runtime evidence is queued after the reviews, so its absence is normal early on and must not
    // stop the reviews from being reported.
    runtimeService.allForResult(snapshotId).catch(() => [] as RuntimeJob[]),
  ]);

  if (!agents.length) return undefined;

  // Only used to key an assessment within its snapshot; the snapshot id keeps that unique when the
  // environment cannot be resolved.
  //
  // Every identity is lower-cased here because that is the invariant `orchestrationGuid` established
  // for an `OrchestrationProgress` and consumers still rely on it: both `art-service` and
  // `runtime-service` compare `environmentId` with `===`. Dataverse returns lower-case GUIDs, but
  // `environmentId` comes from the Power Apps SDK, so it is the one value that can arrive cased
  // differently - and the mismatch fails as a refusal to show the snapshot at all.
  const scope = identity(context.environmentId) || snapshotId;

  const assessments: AssessmentProgress[] = agents.map(row => ({
    environmentId: scope,
    agentId: identity(row.cat_agentid),
    agentName: row.cat_agentname ?? 'Unnamed agent',
    stage: 'agent-review',
    status: REVIEW_STATUS[Number(row.cat_reviewstatus)] ?? 'pending',
    ...(row.cat_agentreviewjobid ? { jobId: identity(row.cat_agentreviewjobid) } : {}),
    ...(row.cat_agentreviewid ? { resultId: identity(row.cat_agentreviewid) } : {}),
    ...(row.cat_errormessage ? { error: row.cat_errormessage } : {}),
  }));

  for (const job of runtimeJobs) {
    assessments.push({
      environmentId: scope,
      agentId: identity(job.agentId),
      agentName: job.agentName ?? 'Unnamed agent',
      stage: 'runtime',
      status: runtimeStatus(job),
      jobId: identity(job.id),
      ...(job.resultId ? { resultId: identity(job.resultId) } : {}),
      ...(job.errorMessage ? { error: job.errorMessage } : {}),
    });
  }

  const unfinished = assessments.some(item => item.status === 'pending' || item.status === 'active');
  // Runtime evidence is queued only once every review has been persisted, so a snapshot with no
  // runtime rows yet is still running - but only while a row can still arrive. Once the reviews have
  // been settled long enough that the queueing step cannot still be in flight, the only honest way
  // to distinguish "not queued yet" from "nothing to queue" is to ask whether any agent could
  // produce evidence at all.
  const awaitingRuntime = runtimeJobs.length
    ? false
    : unfinished || Date.now() - lastTouched(agents) < QUEUEING_GRACE_MS
      ? true
      : await runtimeStillExpected(agents, window);
  const failed = assessments.filter(item => item.status === 'failed');

  return {
    schemaVersion: 1,
    snapshotId,
    revision: assessments.length,
    status: unfinished || awaitingRuntime ? 'running' : failed.length ? 'completed-with-gaps' : 'completed',
    updatedOn: new Date().toISOString(),
    assessments,
    gaps: failed.map(item => `${item.agentName}: ${item.error ?? 'Review failed.'}`),
  };
}
