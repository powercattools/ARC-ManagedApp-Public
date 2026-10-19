import { artService, CURRENT_ORGANIZATION } from './art-service';
import { runtimeService } from './runtime-service';
import { runEngineSnapshot, runEngineUploadSnapshot, runEngineDeclarativeAgentSnapshot, linkRuntimeJobs, type SnapshotRunOutcome } from './snapshot-engine';
import { parseReviewRequest, type ReviewRequest } from '../models/orchestration';
import type { AgentReviewProgress, SnapshotProgress, SnapshotProgressListener } from '../engine/contracts/review-progress';
import type { TargetRuntime, UploadedArtifact } from '../engine/scoring/art-ports';
import type { Review, ReviewResult } from '../models/review';

export const ORCHESTRATED_RULE_PACK = 'architecture-orchestration';

/**
 * Whether a snapshot was produced by a real run.
 *
 * Every snapshot written now is, so this is a question about history rather than about
 * configuration: rows saved while review orchestration was still opt-in carry a placeholder rule
 * pack and a fabricated score, and the detail page has to keep reading them for what they are.
 */
export function isOrchestrated(result: ReviewResult | undefined): boolean {
  return result?.rulePackName === ORCHESTRATED_RULE_PACK;
}

/** Preserve the selected calendar day independently of the browser's timezone. */
export function calendarDay(date: Date | null): string | undefined {
  return date ? new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())).toISOString() : undefined;
}

/**
 * Whether a picked range is one `parseReviewRequest` will accept.
 *
 * `models/orchestration.ts` requires two canonical UTC days with `start < end`,
 * and rejects anything else by throwing. The pickers therefore need the same
 * predicate to decide whether Create can be offered and whether a transcript
 * count is worth requesting - so it lives here once rather than in each of them.
 *
 * Note the comparison is strict, matching the validator: a range must span at
 * least two days, and the end day is inclusive.
 */
export function isSchedulableRange(start: Date | null, end: Date | null): boolean {
  const from = calendarDay(start);
  const to = calendarDay(end);
  return Boolean(from && to && from < to);
}

/**
 * The transcript window the create dialog opens with, and stays editable (FR-088a).
 *
 * A month: wide enough that an agent in light use still has conversations inside it, and close
 * enough to Dataverse's default 29-day retention that the window rarely reaches past what exists.
 */
export const DEFAULT_TRANSCRIPT_RANGE_DAYS = 30;

/**
 * Snapshots this browser tab is currently running.
 *
 * A snapshot that has been scheduled but has not settled is in one of two very different states: it
 * is being driven right now, or it was abandoned when a tab closed and nothing is advancing it. The
 * saved rows cannot tell them apart — a review whose workflow is mid-flight writes nothing for
 * minutes, so silence is not evidence either way — and offering to resume a run that is already
 * going risks two drivers writing the same agent row twice.
 *
 * Tracked in memory because that is exactly the question being asked: not "is anyone running this"
 * but "am I". A tab that closed takes its answer with it, which is the correct answer for the state
 * it left behind.
 */
const driving = new Set<string>();
const drivingListeners = new Set<() => void>();

function setDriving(snapshotId: string, active: boolean): void {
  if (active) driving.add(snapshotId);
  else driving.delete(snapshotId);
  for (const listener of drivingListeners) listener();
}

/** Whether this tab is currently running the snapshot. Safe to call during render. */
export function isDrivingSnapshot(snapshotId: string | undefined): boolean {
  return Boolean(snapshotId && driving.has(snapshotId));
}

/** Subscribe to changes, shaped for `useSyncExternalStore`. */
export function subscribeToDrivingSnapshots(listener: () => void): () => void {
  drivingListeners.add(listener);
  return () => drivingListeners.delete(listener);
}

/**
 * The dates the dialog starts from.
 *
 * This lives beside the validator it has to satisfy rather than in the dialog, because a valid
 * range is part of the request contract: when the picker is hidden - a cross-environment agent,
 * or one with no transcripts to analyse - these are the dates that still get sent.
 */
export function defaultTranscriptRange(): { start: Date; end: Date } {
  const start = new Date();
  start.setDate(start.getDate() - DEFAULT_TRANSCRIPT_RANGE_DAYS);
  return { start, end: new Date() };
}

/**
 * Resolve the environment the reviewed agent lives in, which need not be the one running this app.
 *
 * The agent and its components are read from `review.environmentUrl`; the snapshot, its orchestration
 * rows and the results are written here. `ConnectorTransport` routes that split by table, so nothing
 * downstream has to know two environments are involved.
 *
 * `environmentId` names the environment this review is **orchestrated from**, not the one the agent
 * lives in - the reviewed environment is identified by `organizationUrl`. Resolving the reviewed
 * environment's GUID would need the Power Apps for Makers connector, which this app does not carry.
 * Nothing routes on `environmentId`; it is an identity component, and `agentId` is already unique.
 */
export async function snapshotRequest(
  review: Pick<Review, 'botId' | 'environmentUrl'>,
  snapshot: Pick<ReviewResult, 'id' | 'transcriptStart' | 'transcriptEnd'>,
): Promise<ReviewRequest> {
  const context = await artService.linkContext();
  if (!context.environmentId || !context.organizationUrl || !review.environmentUrl) {
    throw new Error('Open the app in Power Apps and select its current Dataverse environment. The preview needs an environment ID and organization URL.');
  }
  // `GetOrganizations` offers the current environment as the literal `current` sentinel, which the
  // dialog stores verbatim. It is not a URL, so resolve it before parsing or this throws on exactly
  // the environment runtime analysis needs.
  const reviewedUrl = review.environmentUrl.toLowerCase() === CURRENT_ORGANIZATION
    ? context.organizationUrl
    : review.environmentUrl;
  return parseReviewRequest({
    schemaVersion: 1, kind: 'architecture-review-request', snapshotId: snapshot.id,
    environmentId: context.environmentId,
    organizationUrl: new URL(reviewedUrl).origin,
    agentId: review.botId,
    range: { start: snapshot.transcriptStart, end: snapshot.transcriptEnd },
  });
}

/**
 * Run the snapshot: capture the agent graph, review every agent, then gather runtime evidence.
 *
 * Safe to call again for the same saved snapshot, including after reopening the app. Rows are
 * stamped with the snapshot id, so a repeat run adds to that snapshot rather than starting a new
 * one, and runtime analysis de-duplicates against the jobs it already created.
 *
 * Reviews are produced by the engine, which calls the Agent Review Tool's own rubric. There is no
 * second scoring implementation to keep in step.
 *
 * Deliberately not tied to the component that started it. The run outlives the dialog, so dismissing
 * that dialog leaves it going rather than cancelling it; {@link isDrivingSnapshot} is how a view
 * elsewhere in the app knows that is what happened.
 */
export function scheduleSnapshot(review: Review, snapshot: ReviewResult, onProgress?: SnapshotProgressListener): Promise<SnapshotRunOutcome | undefined> {
  return whileDriving(snapshot.id, () => runScheduledSnapshot(review, snapshot, onProgress));
}

/** Marks the snapshot as driven by this tab for exactly as long as `run` is running. */
async function whileDriving<T>(snapshotId: string, run: () => Promise<T>): Promise<T> {
  setDriving(snapshotId, true);
  try {
    return await run();
  } finally {
    setDriving(snapshotId, false);
  }
}

async function runScheduledSnapshot(review: Review, snapshot: ReviewResult, onProgress?: SnapshotProgressListener): Promise<SnapshotRunOutcome | undefined> {
  const request = await snapshotRequest(review, snapshot);

  // The engine reports the review phase; runtime analysis is queued afterwards and is not its
  // business. Holding the last report here lets the runtime phase extend the same agent list rather
  // than replace it, so the dialog keeps every row it has already drawn.
  let latest: SnapshotProgress = { snapshotId: snapshot.id, agents: [], settled: false };
  const publish = (next: SnapshotProgress) => {
    latest = next;
    onProgress?.(next);
  };

  let outcome: SnapshotRunOutcome;
  try {
    outcome = await runEngineSnapshot({ request, onProgress: publish });
  } catch (error) {
    // The snapshot row is already saved, so this is recoverable: reopening it runs against the same
    // frozen request. Naming the snapshot matters — the user must retry this one rather than create
    // another, which would split one agent's history across two runs.
    throw new Error(`Snapshot #${snapshot.sequenceNumber} is saved (${snapshot.id}), but the review did not finish. Retry this saved snapshot; do not create another. ${error instanceof Error ? error.message : String(error)}`);
  }

  const withRuntime = (detailFor: (agent: AgentReviewProgress) => string | undefined, settled: boolean) =>
    publish({
      ...latest,
      agents: latest.agents.map(agent =>
        agent.outcome === 'failed'
          ? agent
          : { ...agent, stage: 'analyzing-runtime' as const, detail: detailFor(agent) },
      ),
      settled,
    });

  withRuntime(() => 'Looking for conversation transcripts', false);

  // Runtime evidence has to cover the same agents the snapshot reviewed, which is why this runs here
  // rather than from the dialog: the connected agents are not known until capture has expanded the
  // graph. A failure to queue it is logged, not thrown - the reviews are already durable.
  const blocked = new Map<string, string>();
  await runtimeService.startForAgents({
    resultId: snapshot.id,
    agents: outcome.reviewedAgents,
    rangeStart: snapshot.transcriptStart,
    rangeEnd: snapshot.transcriptEnd,
    environmentUrl: review.environmentUrl,
    // An agent with no transcripts in range is the commonest outcome by far, and it is not a
    // failure. Saying so beats a row that reads as though the analysis is still starting.
    onBlocked: (agentId, verdict) => blocked.set(
      agentId,
      verdict.reason === 'no-transcripts'
        ? 'No conversation transcripts in this date range'
        : verdict.message ?? 'Runtime analysis is not available for this agent',
    ),
  }).then(started => {
    const queued = new Set(started.map(job => job.agentId));
    withRuntime(agent => queued.has(agent.agentId)
      ? 'Runtime analysis queued'
      : blocked.get(agent.agentId) ?? 'Runtime analysis was not queued', true);
    return linkRuntimeJobs(request.organizationUrl, snapshot.id, started);
  }).catch(error => {
    console.error(`[ArchitectureReview] Snapshot ${snapshot.id} was reviewed but runtime analysis was not queued.`, error);
    withRuntime(() => 'Runtime analysis could not be queued; start it from the Runtime tab', true);
  });

  return outcome;
}

/**
 * Run the snapshot for an uploaded artifact: detect what is in it, review each skill, record them.
 *
 * The sibling of `scheduleSnapshot`. It takes the artifact rather than reading one, because the
 * bytes live in the dialog that chose the file and are never persisted — nothing here could read
 * them back.
 *
 * Runtime analysis is deliberately absent. A skill has no conversations of its own; it runs inside
 * whichever agent loads it, so there are no transcripts to gather (`harness-skill.md` §5).
 */
export async function scheduleUploadSnapshot(
  snapshot: ReviewResult,
  artifact: UploadedArtifact,
  runtimes: TargetRuntime[],
  onProgress?: SnapshotProgressListener,
): Promise<SnapshotRunOutcome | undefined> {
  const organizationUrl = await linkedOrganizationUrl();

  try {
    return await whileDriving(snapshot.id, () => runEngineUploadSnapshot({
      snapshotId: snapshot.id,
      organizationUrl,
      artifact,
      runtimes,
      ...(onProgress ? { onProgress } : {}),
    }));
  } catch (error) {
    // Same contract as the agent path: the snapshot row is already saved, so this is recoverable.
    // The artifact is not, which is why the sentence asks for the file again rather than for a retry
    // of a run that no longer has anything to read.
    throw new Error(`Snapshot #${snapshot.sequenceNumber} is saved (${snapshot.id}), but the review did not finish. Upload the file again from this review rather than creating another. ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Run the snapshot for an uploaded declarative agent package.
 *
 * The third sibling. It takes the `File` rather than this app's `UploadedArtifact` because the
 * engine's detector resolves the manifest's internal references to find the agent and its plugins,
 * which a flat list of file names cannot answer.
 *
 * Runtime analysis is absent for the same reason it is absent from the skill path, arrived at
 * differently: a declarative agent is not a bot in this environment, so there are no transcripts
 * here to gather for it.
 */
export async function scheduleDeclarativeAgentSnapshot(
  snapshot: ReviewResult,
  file: File,
  onProgress?: SnapshotProgressListener,
): Promise<SnapshotRunOutcome | undefined> {
  const organizationUrl = await linkedOrganizationUrl();

  try {
    return await whileDriving(snapshot.id, () => runEngineDeclarativeAgentSnapshot({
      snapshotId: snapshot.id,
      organizationUrl,
      file,
      ...(onProgress ? { onProgress } : {}),
    }));
  } catch (error) {
    throw new Error(`Snapshot #${snapshot.sequenceNumber} is saved (${snapshot.id}), but the review did not finish. Upload the package again from this review rather than creating another. ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The environment the snapshot's rows are written to.
 *
 * Shared by both upload paths rather than duplicated: an upload has no source environment of its
 * own, so for both of them this is the only environment in play, and the sentence a reader sees
 * when it is missing should not depend on which kind of file they picked.
 */
async function linkedOrganizationUrl(): Promise<string> {
  const context = await artService.linkContext();
  if (!context.organizationUrl) {
    throw new Error('Open the app in Power Apps and select its current Dataverse environment. The preview needs an organization URL to save the review.');
  }
  return new URL(context.organizationUrl).origin;
}
