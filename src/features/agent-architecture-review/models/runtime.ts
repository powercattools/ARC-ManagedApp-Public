/**
 * TypeScript mirror of the runtime analyzer's JSON contract.
 *
 * The authority for these shapes is `AgentRuntimeAnalyzer/Core/RuntimeModels.cs`. The plugin serialises
 * with a camel-case resolver, so every property here is the camel-cased C# property name. Keep the two
 * files in step: a rename on either side is a silent break, which is why `schemaVersion` is carried.
 */

/**
 * Bumped by the plugin whenever the report shape changes incompatibly.
 *
 * Must match `RuntimeReport.SchemaVersion` in `AgentRuntimeAnalyzer/Core/RuntimeModels.cs`. Leaving this
 * behind a plugin bump silently hides every new report, because `parseReport` accepts only an exact
 * match — the whole Runtime tab then reads as "never analysed" no matter how many jobs succeed.
 */
export const RUNTIME_SCHEMA_VERSION = 7;

export type ErrorCategory =
  | 'StepFailure'
  | 'Connector'
  | 'Configuration'
  | 'ContentRai'
  | 'Escalation'
  | 'Knowledge'
  | 'Unknown';

export type ComponentKind = 'Topic' | 'Action' | 'Agent' | 'Knowledge' | 'Tool' | 'Unknown';

/** One distinct failure, with the deterministic diagnosis attached to it. */
export interface ErrorGroup {
  typeKey: string;
  type: string;
  category: ErrorCategory;
  count: number;
  affectedConversations: number;
  percentOfErrors: number;
  rootCause: string;
  recommendation: string;
  failedComponent?: string;
  sampleMessages: string[];
  exampleConversationIds: string[];
}

/** One orchestration node, aggregated for the latency view. */
export interface NodeLatencyGroup {
  key: string;
  kind: ComponentKind;
  name: string;
  capability: string;
  calls: number;
  failureCount: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
  percentOfTime: number;
}

/**
 * One classic topic and the node executions observed inside it.
 *
 * Deliberately has no duration of any kind. Classic node traces report a start and an end that are
 * equal to the second, so any millisecond figure derived from them would be a fabricated zero rather
 * than a measurement. `totalSteps` and `avgStepMs` cover timed orchestration steps only, and node
 * executions are never folded into them.
 *
 * `executions` counts nodes, not conversations: a topic of forty nodes entered once and a topic of four
 * nodes entered ten times both report forty. `conversationReach` is what says how much traffic a topic
 * actually carries.
 */
export interface TopicNodeGroup {
  key: string;
  topic: string;
  executions: number;
  conversationReach: number;
  succeededCount: number;
  /** Ended by handing off — a question node exhausting its retries lands here. */
  escalatedCount: number;
  /** Ended the conversation. Fires on normal termination, so it is not a failure signal. */
  cancelledCount: number;
  waitingCount: number;
  /**
   * Executions whose exit was unrecognised, plus those that reported no exit at all. The second case
   * dominates and is not a fault: several node types never emit an exit, so this runs at roughly a
   * tenth of executions on a healthy agent and is presented as "not reported", not as an anomaly.
   */
  otherExitCount: number;
  /** Share of all node executions in the report, not share of traffic. 0-100. */
  percentOfExecutions: number;
  /**
   * Non-success exit reasons and how many executions ended that way. Successes and blank exits are
   * excluded by the analyzer — the first would swamp the map, the second names nothing.
   */
  exitReasons: Record<string, number>;
  exampleConversationIds: string[];
}

export interface ToolUsageGroup {
  kind: ComponentKind;
  name: string;
  calls: number;
  conversationReach: number;
  errorCount: number;
  percentOfCalls: number;
  totalMs: number;
  avgMs: number;
  maxMs: number;
}

/**
 * How strongly the transcripts support the claim that a source was used.
 *
 * Ordered strongest first. The distinction that matters is `confirmed-used` versus `retrieved-only`:
 * being returned by a search is not use. A real transcript shows the top-ranked result being explicitly
 * rejected by the answer, so retrieval alone must never be reported as usage — that overstatement is the
 * defect this model exists to prevent.
 */
export type KnowledgeConfidence =
  | 'ConfirmedUsed'
  | 'LikelyUsed'
  | 'RetrievedOnly'
  | 'SelectedOnly'
  | 'NeverUsed';

/**
 * Human wording for each grade. Phrased as claims about evidence rather than about the source, so a
 * reader cannot mistake "retrieved" for "used" — that conflation is the defect this model corrects.
 */
export const KNOWLEDGE_CONFIDENCE_LABEL: Record<KnowledgeConfidence, string> = {
  ConfirmedUsed: 'Confirmed used',
  LikelyUsed: 'Likely used',
  RetrievedOnly: 'Retrieved, not cited',
  SelectedOnly: 'Searched, not returned',
  NeverUsed: 'Never used',
};

/** Why each grade was assigned, for tooltips and the exported report. */
export const KNOWLEDGE_CONFIDENCE_HINT: Record<KnowledgeConfidence, string> = {
  ConfirmedUsed: 'An answer citation resolved to this source.',
  LikelyUsed: 'The only result a search returned, for an answer that cited nothing.',
  RetrievedOnly: 'Returned as a candidate but never cited by an answer.',
  SelectedOnly: 'Its source group was searched (group-level evidence, not proof this source was) and it never came back in the results.',
  NeverUsed: 'Configured on the agent with no runtime evidence at all.',
};

/**
 * One knowledge source and the evidence that it was actually used.
 *
 * Usage is measured in four escalating stages, because each answers a different question:
 * configured (attached to the agent) → selected (a search targeted its group) → retrieved (returned as a
 * candidate) → cited (an answer attributed to it). Only the last is proof.
 */
export interface KnowledgeUsageGroup {
  /**
   * Stable identity — normalised URL, source name, or a `category:` key. Names alone collide across
   * agents.
   */
  key: string;
  name: string;
  sourceType: string;
  url: string;

  /** Whether the source is attached to the agent, as opposed to an ad-hoc open-web result. */
  configured: boolean;
  configuredConversations: number;
  /**
   * Searches whose selected *group* covered this source. Group-level evidence: Copilot Studio names a
   * group ("Uploaded Files"), never a file, so this never means "this file was selected".
   */
  selectedSearches: number;
  /** Conversations in which this source's group was selected — the denominator of the selection rate. */
  selectedConversations: number;
  retrievedSearches: number;
  citedAnswers: number;
  /** Uncited answers where this ranked top. Weak evidence, deliberately not folded into usage. */
  uncertainUses: number;
  /** Uncited answers where this was the only candidate returned — the basis for `likely-used`. */
  soleCandidateAnswers: number;
  conversationReach: number;

  /** Cited ÷ retrieved, 0-100. Never a 0-1 fraction. */
  citationRatePercent: number;
  selectionRatePercent: number;

  distinctQuestions: number;
  distinctAgents: number;
  lastCitedUtc: string;

  confidence: KnowledgeConfidence;

  totalMs: number;
  avgMs: number;
  timedCount: number;

  exampleConversationIds: string[];
  citedConversationIds: string[];

  /**
   * For an aggregate category, the sites behind it and how many conversations each reached. Empty for
   * every named source.
   *
   * This is what stops "Web search results" being a black box. A row per page was unusable; knowing the
   * traffic concentrates on three domains says which sites are worth attaching as real sources.
   */
  sites: Record<string, number>;
  /** For an aggregate category, how many individual results it absorbed. 0 for a named source. */
  pagesReturned: number;
}

export interface RuntimeReport {
  schemaVersion: number;
  agentId: string;

  /** Conversations folded in — not rows. One conversation can span many transcript rows. */
  transcriptsAnalyzed: number;
  /**
   * Transcript rows behind those conversations. Reported alongside the conversation count because the
   * two diverge badly — 146 rows were 115 conversations on one live agent — and anyone comparing this
   * report against a Dataverse row count needs to see both.
   */
  transcriptRowsAnalyzed: number;
  conversationsWithErrors: number;
  totalErrors: number;
  uniqueErrorTypes: number;
  /**
   * Percentage of analysed conversations that hit at least one error.
   *
   * Every percent-like number in this contract is 0-100, never a 0-1 fraction. The names say so, because
   * a mis-scaled percentage renders as plausible nonsense instead of failing.
   */
  errorRatePercent: number;

  totalSteps: number;
  totalDurationMs: number;
  avgStepMs: number;

  /**
   * Classic node executions observed. Optional, and every reader must treat it as possibly absent: a
   * report stored before this field existed has no value for it, and defaulting that to 0 would state
   * "this agent ran no classic topics" when the truth is "this run never looked".
   *
   * Counted separately from `totalSteps` and never added to it — a step is timed, a node execution is
   * not, so summing them would report a step count the duration figures do not cover. A high value here
   * against a low `totalSteps` is itself the finding: the agent runs classic topic logic rather than
   * generative orchestration, which is why its latency view looks empty.
   */
  totalNodeExecutions?: number;

  totalToolCalls: number;
  totalKnowledgeSearches: number;

  /**
   * How many times a knowledge step ran, and how many of those actually searched. These are raw
   * observations rather than derived totals, and they exist to tell "this agent has no knowledge" apart
   * from "this agent has knowledge it never uses" — the second is a finding, the first is not.
   */
  knowledgeTraces: number;
  knowledgeTracesWithSearch: number;

  /**
   * Knowledge headline figures, all counted over configured sources only — an aggregate category like
   * "Web search results" is not something an agent owner can add or remove. Computed before the source
   * list is capped, so they stay accurate even when `knowledge` holds only the top slice.
   */
  knowledgeSourcesConfigured: number;
  knowledgeSourcesCited: number;
  /** Configured sources with no runtime evidence at all — the removal candidates. */
  knowledgeSourcesNeverUsed: number;
  /** Configured sources dropped from `knowledge` to bound the payload. */
  knowledgeSourcesOmitted: number;
  /**
   * Groups dropped from the other three lists for the same reason. Non-zero means the list is the top
   * slice rather than the whole set, which is the difference between "the errors" and "the top errors".
   */
  errorTypesOmitted: number;
  toolsOmitted: number;
  nodesOmitted: number;
  /** Optional for the same reason as `totalNodeExecutions` — absent on reports stored before Topics. */
  topicNodesOmitted?: number;
  /**
   * Rows that could not be read, and connected-agent conversations that were not followed because the
   * per-chunk cap was reached. Both used to be visible only in the plugin trace, which makes a partial
   * report indistinguishable from a complete one.
   */
  transcriptRowsUnreadable: number;
  connectedConversationsNotFollowed: number;
  /** Answers that retrieved something but cited nothing, so usage cannot be attributed. */
  answersWithoutCitations: number;

  errors: ErrorGroup[];
  nodes: NodeLatencyGroup[];
  /**
   * Classic node executions grouped by topic. Optional and possibly absent, never assumed non-empty:
   * an older stored report omits the property entirely, and an agent that is purely generative has
   * nothing to put in it. Both render as "no classic topics", which is correct in the second case and
   * honest in the first.
   */
  topicNodes?: TopicNodeGroup[];
  tools: ToolUsageGroup[];
  knowledge: KnowledgeUsageGroup[];
}

/** Mirrors the status values the plugin writes to `cat_jobstatus`. */
export const RuntimeJobStatus = {
  Queued: 1,
  Running: 2,
  Paused: 3,
  Succeeded: 4,
  Failed: 5,
} as const;

export type RuntimeJobStatus = (typeof RuntimeJobStatus)[keyof typeof RuntimeJobStatus];

/**
 * Why an analysis cannot produce a result. Kept distinct rather than collapsed into a boolean, because
 * "the agent lives in another environment", "no transcripts exist", "you may not read them" and
 * "recording is switched off" call for four different actions, and only some are the user's own to take.
 */
export type RuntimeBlockReason =
  | 'other-environment'
  | 'recording-off'
  | 'viewing-blocked'
  | 'no-privilege'
  | 'no-agent'
  | 'no-transcripts';

export interface RuntimeJob {
  id: string;
  agentId: string;
  agentName?: string;
  /** The review result (snapshot) this analysis belongs to. */
  resultId?: string;
  status: RuntimeJobStatus;
  chunkIndex: number;
  transcriptsProcessed: number;
  lastStatus?: string;
  errorKind?: string;
  errorMessage?: string;
  report?: RuntimeReport;
  createdOn?: string;
  /**
   * Last write by the plugin. Read to tell a job that is working from one that stopped without
   * saying so: a crashed chain leaves the row on `Running` forever, and only the clock reveals it.
   */
  modifiedOn?: string;
}

/** A preflight verdict, resolved before a run is offered. */
export interface RuntimePreflight {
  canRun: boolean;
  reason?: RuntimeBlockReason;
  message?: string;
  transcriptCount?: number;
}

/**
 * Thrown when a run is refused because it could not produce evidence.
 *
 * Distinct from a failure: nothing went wrong, and there is nothing to retry until the cause is
 * addressed. Callers that fan out over several agents use this to skip one without treating the
 * snapshot as broken, and the UI uses `reason` to say which of the four causes applies.
 */
export class RuntimeBlockedError extends Error {
  readonly reason?: RuntimeBlockReason;
  /** The whole verdict, so a caller can report the transcript count as well as the cause. */
  readonly verdict: RuntimePreflight;

  constructor(verdict: RuntimePreflight) {
    super(verdict.message ?? 'Runtime analysis is not available for this agent.');
    this.name = 'RuntimeBlockedError';
    this.reason = verdict.reason;
    this.verdict = verdict;
  }
}
