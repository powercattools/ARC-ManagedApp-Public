/**
 * The shareable report contract.
 *
 * One rule governs this file: **the JSON is the source of truth and the PDF is rendered from it.**
 * `buildShareReport` produces a `ShareReport`; `renderReportPdf` takes that same object and draws it.
 * Nothing reaches the PDF that is not in the JSON, so the JSON is a strict superset by construction
 * rather than by discipline, and the two cannot drift as the report grows.
 *
 * The report joins two independent sources:
 *   - **design** — what the agent is configured with, from Agent Review Tool (`ArtReview`).
 *   - **runtime** — what actually happened in transcripts, from the runtime analyzer (`RuntimeReport`).
 *
 * Keeping them separate matters. Design data is complete by definition; runtime data is a sample over
 * a date range and is silent about anything that did not occur in it.
 */

import type {
  ArtComponent,
  ArtCoverageBasis,
  ArtCoverageRow,
  ArtCoverageSet,
  ArtFinding,
  ArtInstructionCoverage,
  ArtOrchestration,
  ArtPillar,
  ArtScoreBasis,
} from './art';
import type {
  ErrorGroup,
  KnowledgeConfidence,
  KnowledgeUsageGroup,
  NodeLatencyGroup,
  ToolUsageGroup,
} from './runtime';
import type { AssetType, Grade, LifecycleStatus } from './review';

/**
 * Bumped whenever this shape changes incompatibly. Consumers should check it.
 *
 * - 2 — design + runtime halves, capability-use join.
 * - 3 — design gained `instructionCoverage`, `coverage`/`coverageBasis`/`coverageSets` and
 *   `orchestration`, bringing the report to parity with the Agent Review Tool's own export. Additive,
 *   but a v2 consumer silently omits four sections, so the version moves.
 * - 4 — nullable snapshot scores and exact orchestration assessment/artifact provenance.
 */
export const REPORT_SCHEMA_VERSION = 4;

/**
 * Caps applied when projecting runtime evidence into the report.
 *
 * An error type seen 4,000 times carries 4,000 conversation ids. Ten is enough to go and look at a few
 * real examples, which is the only thing the ids are for, and it keeps the export a readable file
 * rather than a multi-megabyte one.
 */
export const MAX_EXAMPLE_CONVERSATIONS = 10;

/**
 * Sample error messages kept per error type.
 *
 * Deliberately much smaller than the conversation-id cap. Messages are the one field here that can
 * carry text originating from a conversation, so the report keeps just enough to recognise the error
 * and no more. Conversation ids are safe to carry in bulk; message text is not.
 */
export const MAX_SAMPLE_MESSAGES = 3;


/**
 * Whether a configured capability was seen running in the analysed transcripts.
 *
 * Three states rather than a boolean, because "we did not see it" and "we could not have seen it" are
 * different facts and only one of them is a finding.
 */
export type CapabilityUseState = 'observed' | 'not-observed' | 'not-attributable';

/**
 * One configured capability joined to its observed use.
 *
 * This join is the only way to answer "which tools are never called". A tool that never ran does not
 * appear in the runtime report at all — the runtime analyzer can only report what it saw — so the
 * absence has to be found by walking the *design* inventory and looking each entry up.
 */
export interface CapabilityUse {
  kind: 'tool' | 'knowledge';
  name: string;
  /** ART's sub-type, e.g. `ConnectorTool`, `SharePointKnowledgeSource`. */
  subKind?: string;
  state: CapabilityUseState;
  /**
   * Whether this row came from the design inventory. False for capabilities observed at runtime that
   * ART did not inventory — connected-agent hops and platform tools show up this way, and dropping
   * them would make the call totals fail to add up.
   */
  inDesignInventory: boolean;
  /** `null` when not attributable: the transcript never names this capability, so 0 would be a lie. */
  calls: number | null;
  /** Distinct conversations the capability appeared in. `null` when not attributable. */
  conversationReach: number | null;
  errorCount: number | null;
  avgMs: number | null;
  maxMs: number | null;
  /** Knowledge only. `null` when citations are not observable for this source. */
  citationRatePercent: number | null;
  /** Knowledge only. True only when citation data exists *and* nothing was ever cited. */
  neverCited: boolean | null;
  /**
   * Knowledge only. How strongly the transcripts support the claim that the source was used.
   *
   * Carried alongside `neverCited` because the two answer different questions: `neverCited` says no
   * answer attributed to it, while the confidence grade distinguishes a source that was returned and
   * ignored from one that was never even searched. Reporting only the boolean would flatten a source
   * that is retrieval overhead into the same bucket as one that is genuinely unreachable.
   */
  confidence: KnowledgeConfidence | null;
  /** Knowledge only. Answers that cited this source — the one unambiguous proof of use. */
  citedAnswers: number | null;
  /** Conversation ids evidencing the row, for anyone who wants to check the claim. */
  exampleConversationIds?: string[];
}

/** Tool and knowledge use for one agent, plus the totals that give the rates meaning. */
export interface CapabilityUseSummary {
  tools: CapabilityUse[];
  knowledge: CapabilityUse[];
  /** Configured tools with no observed call. Empty when tool use was not attributable at all. */
  neverCalledTools: string[];
  /** Configured knowledge sources with no observed search. */
  neverSearchedKnowledge: string[];
  /** Knowledge searched but never cited — retrieval cost with no demonstrated benefit. */
  searchedButNeverCitedKnowledge: string[];
  /**
   * True when the runtime sample recorded no capability activity whatsoever, which makes every
   * "not observed" unsafe to read as "unused".
   */
  noObservedActivity: boolean;
}

/**
 * An error type as the report carries it — the runtime group with its evidence capped.
 *
 * The counts stay exact; only the example lists are trimmed. Three numbers are deliberately kept apart:
 * `count` (occurrences), `affectedConversations` (real reach, the one to quote for impact) and
 * `totalExampleConversations` (how many example ids the analyzer collected, itself a sample). A reader
 * can then tell "10 examples" from "10 occurrences" from "10 conversations".
 */
export interface ShareReportErrorGroup extends Omit<ErrorGroup, 'exampleConversationIds' | 'sampleMessages'> {
  /** At most `MAX_EXAMPLE_CONVERSATIONS`. */
  exampleConversationIds: string[];
  /** How many example ids existed before capping — not the error's reach. */
  totalExampleConversations: number;
  /** At most `MAX_SAMPLE_MESSAGES`. */
  sampleMessages: string[];
}

/** The runtime half of one agent's report. Mirrors `RuntimeReport`, sorted for presentation. */
export interface ShareReportRuntime {
  schemaVersion: number;
  analyzedOn?: string;
  /** Conversations analysed — not transcript rows. See `RuntimeReport.transcriptsAnalyzed`. */
  transcriptsAnalyzed: number;
  /** Transcript rows behind those conversations; higher whenever a conversation spans rows. */
  transcriptRowsAnalyzed: number;
  conversationsWithErrors: number;
  totalErrors: number;
  uniqueErrorTypes: number;
  errorRatePercent: number;

  totalSteps: number;
  totalDurationMs: number;
  avgStepMs: number;

  totalToolCalls: number;
  totalKnowledgeSearches: number;
  knowledgeTraces: number;
  knowledgeTracesWithSearch: number;

  /** Counted over configured sources only, and before the source list below is capped. */
  knowledgeSourcesConfigured: number;
  knowledgeSourcesCited: number;
  knowledgeSourcesNeverUsed: number;
  knowledgeSourcesOmitted: number;
  /** Answers that retrieved something but cited nothing, so usage cannot be attributed. */
  answersWithoutCitations: number;

  /** Worst first, by total occurrences. Evidence lists are capped — see `ShareReportErrorGroup`. */
  errors: ShareReportErrorGroup[];
  /** Slowest first, by average duration. */
  slowestNodes: NodeLatencyGroup[];
  /** Most called first. Reading it backwards gives least-called, so no second array is stored. */
  tools: ToolUsageGroup[];
  /** Most used first, ranked on citations before retrievals. Read backwards for least used. */
  knowledge: KnowledgeUsageGroup[];
}

/**
 * The design half of one agent's report.
 *
 * Every field is ART's except `score`, which is the review's score as revised by the rules this
 * app's reviewer set aside. The rest of the breakdown stays as the rubric produced it, so the
 * findings beneath a revised score still say exactly what was found.
 */
export interface ShareReportDesign {
  /** `null` when the review withheld a score, so the report can say so rather than printing `0`. */
  score: number | null;
  reviewDate: string;
  sourceEnvironment?: string;
  counts: { passed: number; warnings: number; errors: number; evaluated: number };
  pillars: ArtPillar[];
  findings: ArtFinding[];
  components: ArtComponent[];

  /**
   * The five-element instruction grid.
   *
   * Absent when the review predates the check or the classifier never ran. Absent is not the same as
   * "all five missing", so consumers must not render an empty grid as five failures.
   */
  instructionCoverage?: ArtInstructionCoverage;

  /**
   * How many evaluation cases exercise each configured capability, and on what basis the mapping was
   * made. `coverageBasis` matters: `inferred` means ART matched cases to capabilities by name rather
   * than being told, so a zero can mean "never exercised" or "we could not tell".
   */
  coverage: ArtCoverageRow[];
  coverageBasis: ArtCoverageBasis;
  coverageSets: ArtCoverageSet[];

  /**
   * Provenance of `score`, so the number is never quoted bare.
   *
   * A legacy score and a partial one both look like any other score, and both mean less than they
   * appear to. The Agent Review Tool's own PDF prints this on its cover for the same reason.
   */
  scoreBasis: ArtScoreBasis;

  /**
   * `deep` or `standard`. A standard review could not read each skill's resources, so its clean
   * result covers less ground than a deep one and must not be read as equivalent.
   */
  skillReviewMode?: string;

  /**
   * Findings about how skills interact rather than about any one skill.
   *
   * Agent-level by construction, so they appear nowhere in `findings` and would be silently dropped if
   * this field did not exist.
   */
  orchestration?: ArtOrchestration;
}

/** One agent in the report — the reviewed agent, or one of its connected agents. */
export interface ShareReportAgent {
  botId?: string;
  botName: string;
  isRoot: boolean;
  /** False when this agent has never been reviewed by ART. */
  reviewed: boolean;
  /** Why a connected agent could not be resolved to a bot record. */
  unresolvedReason?: string;
  design?: ShareReportDesign;
  runtime?: ShareReportRuntime;
  /** Present whenever there is a design inventory to join against. */
  capabilityUse?: CapabilityUseSummary;
}

/** Everything identifying the review this report came from. */
export interface ShareReportReview {
  id: string;
  projectName: string;
  assetType: AssetType;
  ownerName: string;
  environmentName?: string;
  environmentUrl?: string;
}

/** The snapshot the report describes, including the transcript window the runtime data covers. */
export interface ShareReportSnapshot {
  id: string;
  sequenceNumber: number;
  score: number | null;
  grade: Grade | null;
  status: LifecycleStatus;
  runTimestamp: string;
  rulePackName: string;
  rulePackVersion: string;
  artifactFileName?: string;
  artifactVersion?: number;
  transcriptStart?: string;
  transcriptEnd?: string;
}

export interface ShareReport {
  orchestration?: import('./orchestration').OrchestrationProgress;
  schemaVersion: number;
  generatedOn: string;
  review: ShareReportReview;
  snapshot: ShareReportSnapshot;
  rollup: {
    rolledUpScore: number | null;
    reviewedCount: number;
    totalCount: number;
  };
  agents: ShareReportAgent[];
  /**
   * Caveats that must travel with the numbers.
   *
   * Carried as data rather than baked into the PDF renderer so the JSON consumer receives the same
   * warnings — a machine-readable export of "never called" without the caveat is precisely how a
   * still-needed capability gets decommissioned.
   */
  notes: string[];
}

/**
 * Why "not observed" must never be printed as "unused".
 *
 * Adapted from the Agent Review Tool's own export note, which exists for the same reason: a fleet of
 * knowledge sources looked removable because the transcript records that class of search under a group
 * name rather than by individual name.
 */
export const OBSERVED_USE_NOTE =
  '"Not observed" means the capability was not seen running in the analysed transcript window. It does '
  + 'not mean the capability is unused. It may simply not have been exercised in this window. "Not '
  + 'attributable" means the transcripts do not name this capability individually, so its use can be '
  + 'confirmed neither way; these are not a provisioning gap.';

/** Stated wherever a citation rate is shown, since not every knowledge source reports citations. */
export const CITATION_NOTE =
  'Citation data is not available for every knowledge source. Where it is missing the citation rate is '
  + 'reported as unknown rather than 0%, because a search that reaches the transcript as a generic '
  + 'search proves a search ran and nothing about what the answer used.';
