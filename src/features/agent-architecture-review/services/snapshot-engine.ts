/**
 * Runs a snapshot on the review engine.
 *
 * This is the app-side composition: it builds the transports, hands them to `runSnapshot`, and
 * persists each agent as it finishes. The engine itself stays free of React, of the generated
 * Dataverse client and of this app's services, so everything environment-specific is assembled here
 * and nowhere else.
 *
 * It replaced a dispatcher-based seed path that queued work for an out-of-process worker. The
 * difference that matters: reviews are produced by the same code path the Agent Review Tool uses,
 * so a rule added there is a rule this snapshot applies, with no second implementation to update.
 */

import { runSnapshot, type SnapshotRunResult } from '../engine/orchestration/snapshot-run';
import {
  runUploadSnapshot,
  type UploadSnapshotRunResult,
} from '../engine/orchestration/upload-run';
import {
  runDeclarativeAgentSnapshot,
  type DeclarativeAgentSnapshotRunResult,
} from '../engine/orchestration/da-run';
import {
  createSnapshotPersistence,
  linkRuntimeJob,
  readPriorAttempts,
} from '../engine/persistence/snapshot-persistence';
import { createPredictTransport } from '../engine/dispatch/predict-transport';
import { resolveReviewModelIds } from '../engine/dispatch/model-catalog';
import type { SnapshotProgressListener } from '../engine/contracts/review-progress';
import type { PriorAgentAttempt } from '../engine/contracts/resume';
import type { TargetRuntime, UploadedArtifact } from '../engine/scoring/art-ports';
import { createConnectorTransport } from './connector-transport';
import type { ReviewRequest } from '../models/orchestration';

/**
 * What a finished run reports.
 *
 * Shaped for the callers that consume it — runtime analysis in particular — so they are unaffected
 * by which engine produced the numbers.
 */
export interface SnapshotRunOutcome {
  snapshotId: string;
  /** Every agent the capture reached: the requested one plus its connected agents. */
  agents: number;
  /** Reviews that finished and were persisted to `cat_agentreviews`. */
  complete: number;
  /** Agents that were reached but could not be reviewed, reported rather than silently dropped. */
  gaps: string[];
  /** Every captured agent, so runtime evidence covers the same set the review did. */
  reviewedAgents: { agentId: string; agentName?: string }[];
  /** Mean of the agents that scored; null when the rubric could score none of them. */
  score: number | null;
}

export interface RunEngineSnapshotOptions {
  request: ReviewRequest;
  onProgress?: SnapshotProgressListener;
  signal?: AbortSignal;
}

export interface RunEngineUploadSnapshotOptions {
  snapshotId: string;
  /** Where the rows are written. An upload has no source environment of its own to read from. */
  organizationUrl: string;
  artifact: UploadedArtifact;
  runtimes: TargetRuntime[];
  onProgress?: SnapshotProgressListener;
  signal?: AbortSignal;
}

export interface RunEngineDeclarativeAgentSnapshotOptions {
  snapshotId: string;
  /** Where the rows are written. An upload has no source environment of its own to read from. */
  organizationUrl: string;
  /** The package as the author chose it. The engine reads it; this layer never opens it. */
  file: File;
  onProgress?: SnapshotProgressListener;
  signal?: AbortSignal;
}

/**
 * Report an upload run in the shape every caller already reads.
 *
 * `reviewedAgents` is always empty, and that is the point rather than an omission: it is the list
 * runtime analysis works from, and a skill has no conversations of its own — it runs inside whichever
 * agent loads it (`harness-skill.md` §5). Returning its subjects here would queue transcript
 * analysis against ids that name no bot.
 */
function summarizeUpload(snapshotId: string, run: UploadSnapshotRunResult): SnapshotRunOutcome {
  const gaps = run.skills
    .filter((skill) => skill.error)
    .map((skill) => `${skill.skill.identity.displayName}: ${skill.error!.message}`);

  // Detection finding nothing is a finished run with no subjects, not a failure. Carrying the
  // reason into the gaps is what stops the snapshot reading as empty for no stated cause.
  if (run.skills.length === 0 && run.reason) gaps.push(run.reason);

  return {
    snapshotId,
    agents: run.skills.length,
    complete: run.skills.filter((skill) => skill.outcome || skill.resumed).length,
    gaps,
    reviewedAgents: [],
    score: run.score,
  };
}

/**
 * Report a declarative-agent run in the shape every caller already reads.
 *
 * `reviewedAgents` is empty for the same reason it is empty for an upload: it is the list runtime
 * analysis works from, and a declarative agent has no conversations in this environment. Its
 * `componentIdUnique` names a manifest, not a bot, so queueing transcript analysis against it would
 * read nothing.
 */
function summarizeDeclarativeAgent(
  snapshotId: string,
  run: DeclarativeAgentSnapshotRunResult,
): SnapshotRunOutcome {
  const gaps: string[] = [];
  if (run.agent && run.error) gaps.push(`${run.agent.displayName}: ${run.error.message}`);
  // Detection finding nothing is a finished run with no subject, not a failure. Carrying the reason
  // into the gaps is what stops the snapshot reading as empty for no stated cause.
  if (!run.agent && run.reason) gaps.push(run.reason);

  return {
    snapshotId,
    agents: run.agent ? 1 : 0,
    complete: run.outcome || run.resumed ? 1 : 0,
    gaps,
    reviewedAgents: [],
    score: run.score,
  };
}

function summarize(snapshotId: string, run: SnapshotRunResult): SnapshotRunOutcome {  const gaps = run.agents
    .filter((agent) => agent.error)
    .map((agent) => `${agent.item.agentName}: ${agent.error!.message}`)
    // An agent that could not be captured never reached review, so it is a gap of a different kind
    // and is reported with the reason capture gave rather than restated as a review failure.
    .concat(run.unresolved.map((agent) => `${agent.declaredName ?? agent.schemaName}: ${agent.reason}`));

  return {
    snapshotId,
    agents: run.agents.length,
    complete: run.agents.filter((agent) => agent.outcome || agent.resumed).length,
    gaps,
    reviewedAgents: run.agents.map((agent) => ({
      agentId: agent.item.agentId,
      agentName: agent.item.agentName,
    })),
    score: run.score,
  };
}

/**
 * Capture, review and persist one snapshot.
 *
 * Reads come from the environment that authored the agent (`request.organizationUrl`); every row
 * written lands in the environment this app is installed in. `ConnectorTransport` routes that split
 * by table name, so neither the engine nor this function has to track which is which.
 *
 * Calling this again for a snapshot that did not finish resumes it: agents already reviewed keep
 * their rows and their scores, and an agent whose workflow job is still running is re-attached to it
 * rather than issued a new one.
 */
export async function runEngineSnapshot(
  options: RunEngineSnapshotOptions,
): Promise<SnapshotRunOutcome> {
  const { request, onProgress, signal } = options;
  const transport = createConnectorTransport(request.organizationUrl);

  // Read before anything is written, so the run knows which agents this snapshot already holds.
  // An interrupted run leaves durable rows behind; without this read the retry the UI offers would
  // review every agent a second time and leave two rows for each.
  const prior = await readPriorAttempts(transport, request.snapshotId).catch((error) => {
    console.error(
      `[ArchitectureReview] Could not read what snapshot ${request.snapshotId} already holds; reviewing every agent.`,
      error,
    );
    return new Map<string, PriorAgentAttempt>();
  });

  const persistence = createSnapshotPersistence({
    transport,
    snapshotId: request.snapshotId,
    prior,
  });

  const run = await runSnapshot({
    transport,
    parentBotId: request.agentId,
    snapshotId: request.snapshotId,
    predict: createPredictTransport(transport),
    modelIds: await resolveReviewModelIds(transport),
    resume: prior,
    ...(onProgress ? { onProgress } : {}),
    ...(signal ? { signal } : {}),
    onAgentReviewed: (item, outcome) => persistence.saveAgentReview(item, outcome).then(() => {}),
  });

  // Failures are recorded after the run rather than inside it. The engine's per-agent hook is the
  // success path, and a snapshot whose persistence failed mid-run should still leave a record of
  // the agents it could not review.
  for (const agent of run.agents) {
    if (!agent.error) continue;
    await persistence.recordFailure(agent.item, agent.error).catch((error) => {
      console.error(
        `[ArchitectureReview] Could not record the failure for "${agent.item.agentName}".`,
        error,
      );
    });
  }

  // The rollup is written last, so the score on the snapshot card can never describe fewer agents
  // than the snapshot actually holds. A failure here loses the cached number, not the reviews.
  await persistence.saveSnapshotScore(run.score).catch((error) => {
    console.error(
      `[ArchitectureReview] Snapshot ${request.snapshotId} was reviewed but its rollup score was not saved.`,
      error,
    );
  });

  return summarize(request.snapshotId, run);
}

/**
 * Capture, review and persist one snapshot of an uploaded artifact.
 *
 * The sibling of `runEngineSnapshot`, and everything it does not need is why it is separate: an
 * upload has no source environment to read from, no bot id to expand a graph from, and no
 * conversations to analyse. Reads and writes are both this environment, so one transport serves
 * both.
 *
 * Re-runnable for the same snapshot on exactly the same terms as an agent run: skills already
 * reviewed keep their rows and their scores, and one still mid-flight is re-attached to its job
 * rather than issued a new one.
 */
export async function runEngineUploadSnapshot(
  options: RunEngineUploadSnapshotOptions,
): Promise<SnapshotRunOutcome> {
  const { snapshotId, organizationUrl, artifact, runtimes, onProgress, signal } = options;
  const transport = createConnectorTransport(organizationUrl);

  const prior = await readPriorAttempts(transport, snapshotId).catch((error) => {
    console.error(
      `[ArchitectureReview] Could not read what snapshot ${snapshotId} already holds; reviewing every skill.`,
      error,
    );
    return new Map<string, PriorAgentAttempt>();
  });

  const persistence = createSnapshotPersistence({ transport, snapshotId, prior });

  const run = await runUploadSnapshot({
    transport,
    artifact,
    runtimes,
    snapshotId,
    predict: createPredictTransport(transport),
    modelIds: await resolveReviewModelIds(transport),
    resume: prior,
    ...(onProgress ? { onProgress } : {}),
    ...(signal ? { signal } : {}),
    onSkillReviewed: (skill, outcome) => persistence.saveSkillReview(skill, outcome).then(() => {}),
  });

  for (const skill of run.skills) {
    if (!skill.error) continue;
    await persistence.recordSkillFailure(skill.skill, skill.error).catch((error) => {
      console.error(
        `[ArchitectureReview] Could not record the failure for "${skill.skill.identity.displayName}".`,
        error,
      );
    });
  }

  await persistence.saveSnapshotScore(run.score).catch((error) => {
    console.error(
      `[ArchitectureReview] Snapshot ${snapshotId} was reviewed but its rollup score was not saved.`,
      error,
    );
  });

  return summarizeUpload(snapshotId, run);
}

/**
 * Capture, review and persist one snapshot of an uploaded declarative agent package.
 *
 * The third sibling of `runEngineSnapshot`, assembled here for the same reason the other two are:
 * the engine stays free of React, of the generated Dataverse client and of this app's services, so
 * everything environment-specific is built in this file and nowhere else.
 *
 * Re-runnable for the same snapshot on exactly the same terms as the other two: a package already
 * reviewed keeps its row and its score, and one still mid-flight is re-attached to its job rather
 * than issued a new one.
 */
export async function runEngineDeclarativeAgentSnapshot(
  options: RunEngineDeclarativeAgentSnapshotOptions,
): Promise<SnapshotRunOutcome> {
  const { snapshotId, organizationUrl, file, onProgress, signal } = options;
  const transport = createConnectorTransport(organizationUrl);

  const prior = await readPriorAttempts(transport, snapshotId).catch((error) => {
    console.error(
      `[ArchitectureReview] Could not read what snapshot ${snapshotId} already holds; reviewing the package.`,
      error,
    );
    return new Map<string, PriorAgentAttempt>();
  });

  const persistence = createSnapshotPersistence({ transport, snapshotId, prior });

  const run = await runDeclarativeAgentSnapshot({
    transport,
    file,
    snapshotId,
    resume: prior,
    ...(onProgress ? { onProgress } : {}),
    ...(signal ? { signal } : {}),
    onDeclarativeAgentReviewed: (agent, outcome) =>
      persistence.saveDeclarativeAgentReview(agent, outcome).then(() => {}),
  });

  if (run.agent && run.error) {
    await persistence.recordDeclarativeAgentFailure(run.agent, run.error).catch((error) => {
      console.error(
        `[ArchitectureReview] Could not record the failure for "${run.agent!.displayName}".`,
        error,
      );
    });
  }

  await persistence.saveSnapshotScore(run.score).catch((error) => {
    console.error(
      `[ArchitectureReview] Snapshot ${snapshotId} was reviewed but its rollup score was not saved.`,
      error,
    );
  });

  return summarizeDeclarativeAgent(snapshotId, run);
}

/**
 * Record which runtime analysis covers each agent in a snapshot.
 *
 * Kept out of `runEngineSnapshot` because the jobs do not exist while it runs - runtime analysis is
 * queued once the graph is complete. Failures are per agent and never thrown: the job itself is
 * already queued and will produce its evidence whether or not this back-reference lands.
 */
export async function linkRuntimeJobs(
  organizationUrl: string,
  snapshotId: string,
  jobs: readonly { id: string; agentId: string }[],
): Promise<void> {
  if (jobs.length === 0) return;
  const transport = createConnectorTransport(organizationUrl);
  await Promise.all(
    jobs.map((job) =>
      linkRuntimeJob(transport, snapshotId, job.agentId, job.id).catch((error) => {
        console.error(
          `[ArchitectureReview] Runtime job ${job.id} was queued but not linked to its agent row.`,
          error,
        );
      }),
    ),
  );
}
