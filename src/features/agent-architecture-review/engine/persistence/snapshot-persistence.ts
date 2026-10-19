/**
 * Snapshot results -> Dataverse.
 *
 * Two rows per agent, and the split is deliberate. The review itself goes to `cat_agentreviews`,
 * the same table and the same shape the Agent Review Tool writes, so one renderer, one PDF export
 * and one set of contracts serve both products. The snapshot's own row goes to
 * `cat_architecturereviewagent`, which records what the review row cannot: the agent graph, the
 * harness, and the identifiers of the rows this agent produced.
 *
 * Review content is never copied into the second row (FR-127). It points at the first one.
 *
 * Browser-safe. No `Buffer`, no `process`, no generated Dataverse client.
 */

import type { EngineTransport } from '../contracts/transport';
import type { AgentCapture } from '../capture/agent-capture';
import type { AgentWorkItem } from '../orchestration/agent-graph';
import type { CopilotReviewOutcome } from '../harnesses/copilot/copilot-review';
import type { HarnessReviewOutcome } from '../harnesses/harness-dispatch';
import type { DetectedSkill } from '../harnesses/skill/skill-detection';
import type { SkillReviewOutcome } from '../harnesses/skill/skill-review';
import type { DetectedDeclarativeAgent } from '../harnesses/declarative-agent/da-detection';
import type { DeclarativeAgentReviewOutcome } from '../harnesses/declarative-agent/da-review';
import type { PriorAgentAttempt, PriorReviewStatus } from '../contracts/resume';
import type { AgentRole } from '../contracts/review-progress';
import {
  buildDAReviewRecord,
  buildReviewRecord,
  carryForwardDismissals,
  keyForResult,
  parseDismissals,
  serializeDismissals,
  serializeReviewRecord,
  REVIEW_JOB_ENTITY_SET,
  type DAReviewRecord,
  type ReviewResult,
} from '../scoring/art-ports';
import { Harness, type HarnessValue } from './schema/metadata.ts';
import { AGENT_SET } from './schema/architecture-review-agent.ts';

/** Entity **set** for `cat_agentreviews`. The logical name is a 404 on the Web API. */
const REVIEW_SET = 'cat_agentreviewses';

/** The snapshot table an agent row and a review row both hang from. */
const SNAPSHOT_SET = 'cat_architecturereviewresults';

const Role = { Parent: 1, Connected: 2 } as const;

/** The capture's harness as the choice value its row stores. */
const HARNESS_VALUE: Record<AgentCapture['harness'], HarnessValue> = {
  standard: Harness.Standard,
  copilot: Harness.Copilot,
};
const ReviewStatus = { Pending: 1, Running: 2, Succeeded: 3, Failed: 4 } as const;

/**
 * What an agent row needs in order to name the thing it describes.
 *
 * An agent supplies it from its capture; an upload has no capture and supplies it directly. The row
 * is the same shape either way, which is the point — a snapshot lists skills beside agents, and a
 * reader comparing two snapshots should not have to know which kind of subject produced a row.
 */
interface RowSubject {
  /** `cat_agentid`, and the id the correlation string is built from. */
  agentId: string;
  agentName: string;
  role: AgentRole;
  depth: number;
  harness: HarnessValue;
  /** Copilot Studio's technical name. An upload has none, and none is invented. */
  schemaName?: string;
}

function subjectOfAgent(item: AgentWorkItem): RowSubject {
  return {
    agentId: item.agentId,
    agentName: item.agentName,
    role: item.role,
    depth: item.depth,
    harness: HARNESS_VALUE[item.capture.harness],
    schemaName: item.capture.schemaName,
  };
}

/**
 * A detected skill as an agent row.
 *
 * Always `parent` at depth 0: skills in one upload are unrelated to one another, so none contains
 * another and the graph the other harnesses record is flat here. The uploaded file name and the hash
 * of its bytes are not copied onto this row — both already travel inside the review's own JSON
 * (`artifactName`, `artifactHash`), and FR-127 keeps review content out of the agent row.
 */
function subjectOfSkill(skill: DetectedSkill): RowSubject {
  return {
    agentId: skill.identity.subjectId,
    agentName: skill.identity.displayName,
    role: 'parent',
    depth: 0,
    harness: Harness.Skill,
  };
}

/**
 * A detected declarative agent as an agent row.
 *
 * `Harness.DeclarativeAgent` is selected directly rather than through `HARNESS_VALUE`, which is
 * keyed on `AgentCapture['harness']` and holds only the two harnesses a capture can have. A DA
 * package has no capture at all, so there is nothing to look the value up by.
 *
 * The id is the package's **storage** identifier — `getDAIdentifier`, already resolved onto
 * `subjectId` by detection — and not the identifier the workflow correlates on. The two differ:
 * a manifest declaring both `declarativeAgentId` and `appId` correlates on the first and is stored
 * under the second, so taking the correlation id here would file the review under a subject the
 * grid never asks for.
 */
function subjectOfDeclarativeAgent(agent: DetectedDeclarativeAgent): RowSubject {
  return {
    agentId: agent.subjectId,
    agentName: agent.displayName,
    role: 'parent',
    depth: 0,
    harness: Harness.DeclarativeAgent,
  };
}

/**
 * Project a finished DA review into ART's DA record contract.
 *
 * Every field is taken from the manifest the review was run against, the same way ART's own hook
 * takes them, so a package reviewed here and the same package reviewed in the Agent Review Tool
 * produce one row with one shape. `iconBase64` is `null` because this engine never reads the
 * package's `color.png` — detection keeps only what the rubric grades — and an absent icon is
 * recorded as absent rather than invented.
 */
function toDAReviewRecord(
  agent: DetectedDeclarativeAgent,
  outcome: DeclarativeAgentReviewOutcome,
): DAReviewRecord {
  const { manifest, manifestHealth, packageValidation, evaluation, workflowProvenance, evidence } =
    outcome.reviewResult;

  return {
    componentIdUnique: agent.subjectId,
    agentName: manifest.name || manifest.shortName || agent.displayName,
    agentVersion: manifest.appVersion ?? '',
    publisherName: manifest.developerName ?? '',
    sourceType: 'zip',
    overallScore: outcome.score,
    iconBase64: null,
    manifest,
    manifestHealth,
    evaluation,
    packageValidation,
    evidence,
    workflowProvenance,
  };
}

export interface SavedAgentReview {
  /** `cat_agentreviews` row holding the review. */
  reviewId: string;
  /** `cat_architecturereviewagent` row for this agent in this snapshot. */
  agentRowId: string;
}

export interface SnapshotPersistenceOptions {
  transport: EngineTransport;
  /** Every row written here is stamped with it; without it a re-review is indistinguishable. */
  snapshotId: string;
  /**
   * Rows an earlier run of this snapshot already wrote, keyed by agent id.
   *
   * Supplied on a resumed run so an agent updates the row it already has instead of gaining a
   * second one. Omitted on a first run, where there is nothing to reuse.
   */
  prior?: ReadonlyMap<string, PriorAgentAttempt>;
}

export interface SnapshotPersistence {
  saveAgentReview(item: AgentWorkItem, outcome: HarnessReviewOutcome): Promise<SavedAgentReview>;
  recordFailure(item: AgentWorkItem, error: Error): Promise<string>;
  /**
   * The upload arm of {@link saveAgentReview}.
   *
   * Separate rather than a third branch of the same method, because a skill review is a different
   * contract — ART's `ArtifactReviewResult`, not its agent `ReviewResult` — and because a skill has
   * no `AgentCapture` to identify it with. The agent row the two produce is identical in shape.
   */
  saveSkillReview(skill: DetectedSkill, outcome: SkillReviewOutcome): Promise<SavedAgentReview>;
  recordSkillFailure(skill: DetectedSkill, error: Error): Promise<string>;
  /**
   * The declarative-agent arm of {@link saveAgentReview}.
   *
   * A third sibling for the same reason the skill arm is a second one: a DA review is ART's
   * `DAReviewRecord`, judged on six criteria of its own, and it shares neither the agent contract
   * nor the skill one. The agent row all three write is identical in shape, which is what lets a
   * snapshot list a declarative agent beside a copilot agent without the reader knowing which
   * harness produced which row.
   */
  saveDeclarativeAgentReview(
    agent: DetectedDeclarativeAgent,
    outcome: DeclarativeAgentReviewOutcome,
  ): Promise<SavedAgentReview>;
  recordDeclarativeAgentFailure(agent: DetectedDeclarativeAgent, error: Error): Promise<string>;
  /**
   * Write the snapshot's rollup once every agent has been reviewed.
   *
   * The snapshot row is created before the run starts and deliberately carries no score, because
   * none exists yet; this fills it in. `cat_grade` is left unset - the banding that turns a rollup
   * into a letter is not designed (FR-103), and a cached grade outlives the cache being right.
   */
  saveSnapshotScore(score: number | null): Promise<void>;
}

/**
 * Project a finished review into ART's review contract.
 *
 * The copilot arm mirrors what the Agent Review Tool stores for the same harness, field for field.
 * A snapshot review that recorded different numbers from an ART review of the same agent would make
 * the two products disagree about one artefact, which is the outcome the shared rubric exists to
 * prevent.
 */
function toReviewResult(capture: AgentCapture, outcome: HarnessReviewOutcome): ReviewResult {
  // A standard review already *is* the contract: `assembleStandardReviewResult` builds the
  // `ReviewResult` itself from the workflow's evaluation, and the harness hands it back unsaved.
  // Rebuilding it here would be a second implementation of ART's projection, free to drift.
  if (outcome.harness === 'standard') return outcome.reviewResult;

  return toCopilotReviewResult(capture, outcome);
}

function toCopilotReviewResult(
  capture: AgentCapture,
  outcome: CopilotReviewOutcome,
): ReviewResult {
  const { payload } = outcome;
  // Null means the rubric could not score this agent. ART stores 0 and records the distinction in
  // `overallScoreApplicable`, so the two stay separable when the row is read back.
  const storedScore = payload.score.grounded ?? 0;
  const started = Date.parse(outcome.startedAt);
  const completed = Date.parse(outcome.completedAt);

  return {
    botId: capture.botId,
    componentIdUnique: capture.componentIdUnique,
    botName: capture.botName,
    sourceEnvironment: capture.organization,
    agentVersion: capture.agentVersion,
    reviewKind: 'copilot',
    overallScore: storedScore,
    overallScoreApplicable: payload.score.grounded !== null,
    patternScore: storedScore,
    instructionScore: storedScore,
    highSeverityCount: payload.score.errors,
    mediumSeverityCount: payload.score.warnings,
    lowSeverityCount: 0,
    totalIssueCount: payload.score.errors + payload.score.warnings,
    reviewedOn: new Date(Number.isFinite(completed) ? completed : Date.now()),
    durationMs:
      Number.isFinite(started) && Number.isFinite(completed) ? Math.max(0, completed - started) : 0,
    status: 'completed',
    agentsExperience: outcome.persisted.payload,
  } as ReviewResult;
}

/**
 * Write snapshot results.
 *
 * Rows carry client-supplied primary keys. Dataverse accepts them, and generating the id before the
 * request means a response lost in flight leaves a row this code can still find rather than an
 * orphan that is never collected.
 */
export function createSnapshotPersistence(
  options: SnapshotPersistenceOptions,
): SnapshotPersistence {
  const { transport, snapshotId, prior } = options;
  const snapshotBind = { 'cat_resultid@odata.bind': `${SNAPSHOT_SET}(${snapshotId})` };

  /** `snapshotId:agentId` — joins an agent to its job without a botId-and-time-window guess. */
  const correlationFor = (agentId: string) => `${snapshotId}:${agentId}`;

  /**
   * The rules a previous snapshot had set aside for this agent, narrowed to the ones this review
   * actually produced.
   *
   * Found from the agent's own history rather than passed in. A dismissal is a judgement about the
   * agent, so "the last time anyone decided this rule does not apply here" is the right thing to
   * inherit, and it is answerable from the rows themselves — which also means a snapshot started
   * from a different review still picks up decisions already made about the same agent.
   *
   * Narrowing matters: a dismissal whose rule no longer fires, or whose skill has been deleted, has
   * nothing to attach to, and keeping it would leave a decision lying in wait to re-apply months
   * later if a component of the same name reappeared.
   *
   * A review that recorded no rule outcomes is carried verbatim instead. An empty result list means
   * "this harness does not record them", not "no rule matched", and pruning against it would erase
   * every decision the reviewer had made.
   *
   * That is why only `agentsExperience.ruleResults` is passed, never the top-level `ruleResults`.
   * Widening it to cover the standard harness looks like the obvious completion of this function
   * and is the opposite of one: the two sides key the same rule differently. A standard dismissal
   * is stored under the raw `PatternId` the UI rendered (`workflow-unclear-model-name`,
   * `art-service.ts` `parseStandardRuleResults`), while the engine's stored `ruleResults` key it
   * under the registered id (`STD-PATTERN-MODEL-NAME`, via `resolveStandardRuleId`). Pruning raw
   * keys against resolved ones matches nothing, so every pattern dismissal would be filtered away
   * and written back as `null` — silently destroying the reviewer's decisions at the next
   * re-review. Unify the two key spaces, with a migration for stored keys, before narrowing here.
   *
   * The newest settled review wins even when it set nothing aside. Clearing the last manual pass
   * stores `null`, which is indistinguishable from "this review never had any" — but both say the
   * same thing: as of that review, nothing was set aside for this agent. Skipping such a row to
   * reach an older one would resurrect decisions the reviewer had just undone, and the score would
   * never fall back. `cat_reviewstatus` is what makes the empty column readable as an answer: a
   * failed attempt never reached the question, so it must not be mistaken for a cleared list. It
   * arrives as a string from the connector, so it is read through `toPriorStatus` rather than
   * compared to the numeric choice — a strict `===` against the number is never true in
   * production, which would disable carry-forward while every numeric test fixture stayed green.
   *
   * A failed row that still carries a list is read anyway: `recordFailure` flips an already-settled
   * row to Failed without clearing `cat_dismissedrules`, so those decisions are current rather than
   * abandoned, and stepping over them to reach an older snapshot would lose them.
   *
   * Failure is silent by design. Losing a snapshot because its predecessors could not be read would
   * trade a whole review for a convenience.
   */
  async function carriedDismissals(
    agentId: string,
    currentResults: readonly { key: string }[],
  ): Promise<string | undefined> {
    try {
      const filter = `cat_agentid eq '${agentId}'`;
      const rows = await transport.rows(
        `${AGENT_SET}?$select=cat_dismissedrules,cat_correlationid,cat_reviewstatus` +
          `&$filter=${encodeURIComponent(filter)}&$orderby=createdon desc&$top=20`,
        20,
      );

      const mine = correlationFor(agentId);
      const newest = rows.find(row => {
        if (row.cat_correlationid === mine) return false;
        // A settled review answered the question, even when the answer was "nothing is ignored".
        if (toPriorStatus(row.cat_reviewstatus) === 'succeeded') return true;
        // A review that failed after the reviewer had already decided still holds those decisions.
        return typeof row.cat_dismissedrules === 'string' && row.cat_dismissedrules.length > 0;
      });
      if (!newest) return undefined;

      const previous = parseDismissals(
        typeof newest.cat_dismissedrules === 'string' ? newest.cat_dismissedrules : null,
      );
      if (previous.length === 0) return undefined;

      return serializeDismissals(
        currentResults.length ? carryForwardDismissals(previous, currentResults) : previous,
      ) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Write one agent's row, reusing the row a previous run left behind.
   *
   * The identity of this row is `snapshotId:agentId`, so a resumed run must update rather than
   * insert. Two rows for one agent in one snapshot would double it in every count the snapshot
   * reports, and `linkRuntimeJob` resolves an agent by that correlation id and takes the first
   * match — so runtime evidence would land on an arbitrary one of the pair.
   */
  async function writeAgentRow(
    subject: RowSubject,
    fields: Record<string, unknown>,
  ): Promise<string> {
    const shared = {
      cat_name: subject.agentName,
      cat_agentid: subject.agentId,
      cat_agentname: subject.agentName,
      cat_role: subject.role === 'parent' ? Role.Parent : Role.Connected,
      cat_depth: subject.depth,
      cat_harness: subject.harness,
      cat_correlationid: correlationFor(subject.agentId),
      ...(subject.schemaName === undefined ? {} : { cat_schemaname: subject.schemaName }),
      ...fields,
    };

    const existing = prior?.get(subject.agentId)?.rowId;
    if (existing) {
      // Already bound to this snapshot when it was created, so the lookup is left alone. The
      // explanation is cleared first: an agent that failed before and succeeded now must not keep
      // the old reason, and `shared` puts it back for a caller that is recording a fresh failure.
      await transport.patch(`${AGENT_SET}(${existing})`, { cat_errormessage: null, ...shared });
      return existing;
    }

    const agentRowId = crypto.randomUUID();
    const response = await transport.request('POST', AGENT_SET, {
      cat_architecturereviewagentid: agentRowId,
      ...shared,
      ...snapshotBind,
    });
    if (response.status >= 300) {
      throw new Error(`Could not record agent "${subject.agentName}" (HTTP ${response.status}).`);
    }
    return agentRowId;
  }

  return {
    /**
     * Save one finished review, then the agent row that points at it.
     *
     * In that order, so the agent row never references a review that does not exist. The reverse
     * would leave a dangling identifier if the second write failed, and a snapshot that claims a
     * review it cannot open is worse than one that is visibly missing an agent.
     */
    async saveAgentReview(
      item: AgentWorkItem,
      outcome: HarnessReviewOutcome,
    ): Promise<SavedAgentReview> {
      const reviewId = crypto.randomUUID();
      const result = toReviewResult(item.capture, outcome);
      const record = serializeReviewRecord(result);
      // Only on a row this run creates. Resuming re-reviews an agent whose row already exists, and
      // that row's own list is the newer decision — overwriting it with an older snapshot's would
      // silently undo an override the reviewer made between the two attempts.
      // The standard harness hands back ART's own result, which carries its rule results at the
      // top level; only the copilot payload nests them under `agentsExperience`. Reading one source
      // alone silently stops the pruning below for the other harness, leaving a dismissal whose
      // rule no longer fires lying in wait to re-apply.
      const carried = prior?.has(item.agentId)
        ? undefined
        : await carriedDismissals(item.agentId, result.agentsExperience?.ruleResults ?? []);

      const created = await transport.request('POST', REVIEW_SET, {
        cat_agentreviewsid: reviewId,
        ...record,
        ...snapshotBind,
      });
      if (created.status >= 300) {
        throw new Error(
          `Could not save the review for "${item.agentName}" (HTTP ${created.status}).`,
        );
      }

      const agentRowId = await writeAgentRow(subjectOfAgent(item), {
        cat_reviewstatus: ReviewStatus.Succeeded,
        cat_agentreviewid: reviewId,
        // Copilot only. A standard review has no durable job row — its two AI calls answer in the
        // same HTTP response — so there is no job id to record, and none is invented.
        ...(outcome.harness === 'copilot' && outcome.jobId
          ? { cat_agentreviewjobid: outcome.jobId }
          : {}),
        // `cat_score` only. The score-to-letter banding is not designed yet (FR-103), and inventing
        // one here would put a rubric decision in the persistence layer, where it cannot be seen.
        ...(outcome.score === null ? {} : { cat_score: outcome.score }),
        ...(carried ? { cat_dismissedrules: carried } : {}),
      });

      return { reviewId, agentRowId };
    },

    /**
     * Record an agent the snapshot tried and could not review.
     *
     * Written as evidence rather than dropped. A snapshot that silently omits a failed agent reports
     * a rollup over fewer agents than it claims to cover, and nothing on the record says why.
     */
    async recordFailure(item: AgentWorkItem, error: Error): Promise<string> {
      return writeAgentRow(subjectOfAgent(item), {
        cat_reviewstatus: ReviewStatus.Failed,
        cat_errormessage: error.message.slice(0, 8192),
      });
    },

    /**
     * Save one finished skill review, then the agent row that points at it.
     *
     * The review row is ART's, built by ART's own mapping: a skill reviewed inside a snapshot and the
     * same skill reviewed in the Agent Review Tool are one record in one table, discriminated by
     * `cat_agenttype`, and that is what lets a single renderer and a single export serve both.
     *
     * The only thing added here is the snapshot binding — which is also the only thing that makes
     * this review comparable to the one before it.
     */
    async saveSkillReview(
      skill: DetectedSkill,
      outcome: SkillReviewOutcome,
    ): Promise<SavedAgentReview> {
      const reviewId = crypto.randomUUID();
      const record = buildReviewRecord(outcome.reviewResult, keyForResult(outcome.reviewResult));

      const created = await transport.request('POST', REVIEW_SET, {
        cat_agentreviewsid: reviewId,
        ...record,
        ...snapshotBind,
      });
      if (created.status >= 300) {
        throw new Error(
          `Could not save the review for "${skill.identity.displayName}" (HTTP ${created.status}).`,
        );
      }

      const agentRowId = await writeAgentRow(subjectOfSkill(skill), {
        cat_reviewstatus: ReviewStatus.Succeeded,
        cat_agentreviewid: reviewId,
        // A skill's AI stage runs through the same durable job as a copilot review, so there is a
        // job id to record whenever the workflow backend served it. A prompt-served review has none.
        ...(outcome.jobId ? { cat_agentreviewjobid: outcome.jobId } : {}),
        ...(outcome.score === null ? {} : { cat_score: outcome.score }),
      });

      return { reviewId, agentRowId };
    },

    async recordSkillFailure(skill: DetectedSkill, error: Error): Promise<string> {
      return writeAgentRow(subjectOfSkill(skill), {
        cat_reviewstatus: ReviewStatus.Failed,
        cat_errormessage: error.message.slice(0, 8192),
      });
    },

    /**
     * Save one finished declarative-agent review, then the agent row that points at it.
     *
     * The review row is ART's, built by ART's own `buildDAReviewRecord`: a package reviewed inside
     * a snapshot and the same package reviewed in the Agent Review Tool are one record in one
     * table, discriminated by `cat_agenttype = 2`.
     *
     * No dismissal carry-forward. A DA review is scored from six weighted criteria rather than from
     * rule verdicts, so there is no rule key a reviewer could have dismissed and nothing for a
     * previous snapshot to hand forward.
     */
    async saveDeclarativeAgentReview(
      agent: DetectedDeclarativeAgent,
      outcome: DeclarativeAgentReviewOutcome,
    ): Promise<SavedAgentReview> {
      const reviewId = crypto.randomUUID();
      const record = buildDAReviewRecord(toDAReviewRecord(agent, outcome), outcome.completedAt);

      const created = await transport.request('POST', REVIEW_SET, {
        cat_agentreviewsid: reviewId,
        ...record,
        ...snapshotBind,
      });
      if (created.status >= 300) {
        throw new Error(
          `Could not save the review for "${agent.displayName}" (HTTP ${created.status}).`,
        );
      }

      const agentRowId = await writeAgentRow(subjectOfDeclarativeAgent(agent), {
        cat_reviewstatus: ReviewStatus.Succeeded,
        cat_agentreviewid: reviewId,
        ...(outcome.jobId ? { cat_agentreviewjobid: outcome.jobId } : {}),
        ...(outcome.score === null ? {} : { cat_score: outcome.score }),
      });

      return { reviewId, agentRowId };
    },

    async recordDeclarativeAgentFailure(
      agent: DetectedDeclarativeAgent,
      error: Error,
    ): Promise<string> {
      return writeAgentRow(subjectOfDeclarativeAgent(agent), {
        cat_reviewstatus: ReviewStatus.Failed,
        cat_errormessage: error.message.slice(0, 8192),
      });
    },

    async saveSnapshotScore(score: number | null): Promise<void> {
      // A snapshot that scored nothing keeps an empty score rather than a zero: "not scored" and
      // "scored zero" are different findings, and the card reads the same column for both.
      if (score === null || !Number.isFinite(score)) return;
      await transport.patch(`${SNAPSHOT_SET}(${snapshotId})`, {
        cat_score: String(Math.round(score)),
      });
    },
  };
}

/**
 * The workflow jobs an earlier run of this snapshot submitted, keyed by agent id.
 *
 * Read alongside the agent rows because the two record different halves of a run. An agent row is
 * written when a review has been *collected*; a job row exists from the moment one is *submitted*.
 * A run interrupted in between — the tab closed while the flow was still executing — therefore
 * leaves a finished job and no agent row, and without this query its results are stranded: the
 * snapshot keeps no score and a re-run pays for a second flow execution that reviews the same bytes.
 *
 * Joined on `cat_correlationid` rather than a lookup because `cat_agentreviewjob` ships with the
 * Agent Review Tool and has no snapshot column — `createReviewJob` stamps `snapshotId:agentId` for
 * exactly this purpose. The agent id is taken as everything after the first separator, since ids
 * are themselves namespaced (`skill:order-resolution-concierge`).
 */
async function readSnapshotJobs(
  transport: EngineTransport,
  snapshotId: string,
): Promise<Map<string, string>> {
  const jobs = new Map<string, string>();
  // The id is composed by this code, never entered by a user, but it lands inside an OData string
  // literal — so a quote can only be a bug, and guessing at an escaping is worse than not asking.
  if (snapshotId.includes("'")) return jobs;

  const prefix = `${snapshotId}:`;
  try {
    const rows = await transport.rows(
      `${REVIEW_JOB_ENTITY_SET}?$select=cat_agentreviewjobid,cat_correlationid` +
        `&$filter=${encodeURIComponent(`startswith(cat_correlationid,'${prefix}')`)}` +
        `&$orderby=${encodeURIComponent('createdon asc')}`,
    );
    for (const row of rows) {
      const correlation = row.cat_correlationid;
      const jobId = row.cat_agentreviewjobid;
      if (typeof correlation !== 'string' || typeof jobId !== 'string') continue;
      if (!correlation.startsWith(prefix)) continue;
      const agentId = correlation.slice(prefix.length);
      // Oldest first, so a resubmitted agent ends up pointing at its most recent job.
      if (agentId) jobs.set(agentId, jobId);
    }
  } catch {
    // Recovery is an improvement on the run, not a precondition for it. A snapshot whose jobs
    // cannot be read still reviews from scratch, exactly as it did before this existed.
    return new Map();
  }
  return jobs;
}

/**
 * What an earlier run of this snapshot already recorded, keyed by agent id.
 *
 * Read once before a run starts. An empty map — the ordinary case — makes the run behave exactly as
 * it did before resume existed, so the first run of a snapshot pays one query and nothing else.
 *
 * Rows are found through the snapshot lookup rather than the correlation id, because the lookup is
 * the relationship Dataverse indexes and the correlation id is a string this code composes. They
 * agree by construction; the lookup is simply the cheaper and more truthful of the two.
 */
export async function readPriorAttempts(
  transport: EngineTransport,
  snapshotId: string,
): Promise<Map<string, PriorAgentAttempt>> {
  const [rows, jobs] = await Promise.all([
    transport.rows(
      `${AGENT_SET}?$select=cat_architecturereviewagentid,cat_agentid,cat_reviewstatus,` +
        `cat_agentreviewid,cat_agentreviewjobid,cat_score` +
        `&$filter=${encodeURIComponent(`_cat_resultid_value eq ${snapshotId}`)}`,
    ),
    readSnapshotJobs(transport, snapshotId),
  ]);

  const prior = new Map<string, PriorAgentAttempt>();
  for (const row of rows) {
    const agentId = row.cat_agentid;
    const rowId = row.cat_architecturereviewagentid;
    if (typeof agentId !== 'string' || typeof rowId !== 'string') continue;

    const attempt: PriorAgentAttempt = { rowId, status: toPriorStatus(row.cat_reviewstatus) };
    if (typeof row.cat_agentreviewid === 'string') attempt.reviewId = row.cat_agentreviewid;
    if (typeof row.cat_agentreviewjobid === 'string') attempt.jobId = row.cat_agentreviewjobid;

    const score = Number(row.cat_score);
    if (row.cat_score !== null && row.cat_score !== undefined && Number.isFinite(score)) {
      attempt.score = score;
    }

    // A snapshot should hold one row per agent; if an earlier build left two, the settled one wins
    // so a resume carries the finished review forward rather than re-running it.
    const seen = prior.get(agentId);
    if (!seen || (seen.status !== 'succeeded' && attempt.status === 'succeeded')) {
      prior.set(agentId, attempt);
    }
  }

  // Fold in the jobs an interrupted run left behind. An agent whose review was already collected is
  // left untouched — it is finished, and its own row names the job it came from.
  for (const [agentId, jobId] of jobs) {
    const attempt = prior.get(agentId);
    if (!attempt) {
      // No row at all: the run was interrupted before anything about this agent was recorded.
      // Reported as running so the resumed run re-attaches to the job rather than carrying a
      // score forward that was never collected.
      prior.set(agentId, { status: 'running', jobId });
      continue;
    }
    if (!attempt.reviewId && !attempt.jobId) attempt.jobId = jobId;
  }

  return prior;
}

/** Choice values are numbers, but a connector may hand them back as strings. */
function toPriorStatus(value: unknown): PriorReviewStatus {
  switch (Number(value)) {
    case ReviewStatus.Succeeded:
      return 'succeeded';
    case ReviewStatus.Failed:
      return 'failed';
    case ReviewStatus.Running:
      return 'running';
    default:
      return 'pending';
  }
}

/**
 * Point an agent row at the runtime analysis queued for it.
 *
 * Written separately from the review because the two happen at different times: an agent is
 * reviewed as soon as it is captured, but runtime analysis cannot start until the whole graph is
 * known, so the job id does not exist when the row is first written.
 *
 * The row is found by correlation id rather than by `cat_agentid`, because the same agent appears
 * in every snapshot ever taken of it and only the correlation distinguishes this one.
 */
export async function linkRuntimeJob(
  transport: EngineTransport,
  snapshotId: string,
  agentId: string,
  runtimeJobId: string,
): Promise<void> {
  const correlation = `${snapshotId}:${agentId}`;
  const rows = await transport.rows(
    `${AGENT_SET}?$select=cat_architecturereviewagentid` +
      `&$filter=${encodeURIComponent(`cat_correlationid eq '${correlation}'`)}`,
  );
  const rowId = rows[0]?.cat_architecturereviewagentid;
  if (typeof rowId !== 'string') return;
  await transport.patch(`${AGENT_SET}(${rowId})`, { cat_runtimeanalysisjobid: runtimeJobId });
}
