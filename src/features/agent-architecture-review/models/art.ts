/**
 * Domain types for Agent Review Tool (ART) results.
 *
 * These mirror what ART actually persists, verified against a live review in
 * Copilot Studio Kit - Dev (`ZAVA Visual Merchandiser`, 2026-08-25):
 *
 *   cat_agentreviews.cat_reviewresultjson
 *     └── agentsExperience
 *           ├── model    — the component inventory ("map details")
 *           ├── findings — per-finding recommendations, optionally component-scoped
 *           └── score    — weighted pillars, and the rolled-up number
 *
 * Nothing here re-derives a score. ART owns the rubric; this app reads it.
 * The one derived value is `rolledUpScore` across *several* agents, which ART
 * genuinely does not provide — see `aggregateScore`.
 */

import type { DAStoredReviewData, StandardReviewWorkflowProvenance } from '../engine/scoring/art-ports';

/** Severity as ART emits it. */
import {
  hasScore,
  overallScoreOf,
  type ArtifactReviewResult,
  type CopilotReviewDisplayPayload,
  type LegacyPillarName,
} from '../engine/scoring/art-ports';

export type ArtSeverity = 'error' | 'warning' | 'info';

/** Severity as the Figma design labels it (frame 8673:12290). */
export type DisplaySeverity = 'High' | 'Medium' | 'Low';

/**
 * ART speaks error/warning/info; the design speaks High/Medium/Low. Mapping
 * here rather than at each call site keeps the two vocabularies from leaking
 * into each other.
 */
const SEVERITY_DISPLAY: Record<ArtSeverity, DisplaySeverity> = {
  error: 'High',
  warning: 'Medium',
  info: 'Low',
};

/** Sort order for findings — worst first. */
const SEVERITY_RANK: Record<ArtSeverity, number> = { error: 0, warning: 1, info: 2 };

export function displaySeverity(severity: ArtSeverity): DisplaySeverity {
  return SEVERITY_DISPLAY[severity];
}

export function severityRank(severity: ArtSeverity): number {
  return SEVERITY_RANK[severity] ?? 3;
}

/**
 * The label a pre-refactor row carries on the left half of the old 50/50 blend.
 *
 * Not a pillar, and deliberately not spelled as one. Reviews saved before the standard harness
 * moved onto the six-pillar rubric persisted two sub-scores rather than a breakdown, and
 * `parseStandardReview` reconstructs them so an older review still renders. Giving the label its
 * own type is what lets the compiler keep those rows out of anything that scores: a scorer handed
 * `'Patterns'` finds no weight for it and drops the row without raising anything.
 */
export const LEGACY_BLEND_PILLAR = 'Patterns';

/** The names an {@link ArtPillar} row may carry — the six real pillars, plus the legacy label. */
export type ArtPillarName = LegacyPillarName | typeof LEGACY_BLEND_PILLAR;

/**
 * One scored pillar. ART returns six, each carrying its own weight, and the
 * weights sum to 100 — so the rolled-up score is reproducible from these alone.
 */
export interface ArtPillar {
  /**
   * The pillar this row scores, in ART's persisted Title-case spelling.
   *
   * Typed rather than left as a string so the rescore path can hand it straight
   * to ART without a cast: an arbitrary string asserted into ART's union is a
   * silent mismatch waiting for the first row that spells a pillar differently.
   * `parsePillars` normalises on the way in.
   *
   * {@link LEGACY_BLEND_PILLAR} widens this for pre-refactor rows only. Narrow it away before
   * handing a row to a scorer — {@link scoredPillars} does that.
   */
  name: ArtPillarName;
  weight: number;
  /**
   * The pillar's score, or `null` when the review withheld one.
   *
   * Nullable rather than defaulted to zero: ART persists `score: null` for a pillar it could not
   * measure and leaves its weight out of the composite, so coercing that to `0` would both report
   * the agent as having failed the pillar outright and drag any recompute below the stored score.
   */
  score: number | null;
  applicable: boolean;
  complete: boolean;
}

/**
 * One rule's outcome.
 *
 * A finding is a reason, not a result: a rule with nothing to say produces none, so findings alone
 * cannot tell a clean agent from an unreviewed one. These are the results themselves — every rule
 * that ran, including the silent ones — which is what lets the review show passes and what it could
 * not assess rather than only its complaints.
 */
export interface ArtRuleResult {
  /** Unique per instance: `ruleId` for an agent-level rule, `ruleId:component` for a per-component one. */
  key: string;
  ruleId: string;
  family: string;
  status: 'passed' | 'info' | 'warning' | 'error' | 'not-applicable' | 'failed';
  /** Display name of the component this instance judged, when it judged one. */
  subject?: string;
  subjectId?: string;
  /** `record` states a fact about the agent rather than judging it, and is never scored. */
  kind?: 'check' | 'record';
  /**
   * The rule's own name, when the harness records one.
   *
   * A copilot rule has none — its name is looked up from the rule id — but a standard pattern
   * ships its `PatternName`, so it names its own row.
   */
  title?: string;
  /** The harness's own reason for a not-assessed outcome, preferred over the generic wording. */
  note?: string;
}

/**
 * One finding. `componentIdUnique` is present only for component-scoped
 * findings; agent-level findings (model settings, lifecycle) omit it.
 */
export interface ArtFinding {
  id: string;
  family: string;
  severity: ArtSeverity;
  title: string;
  /** What was observed. */
  fact?: string;
  /** Why it matters. */
  why?: string;
  /** What to do about it — the actual recommendation. */
  fix?: string;
  /**
   * How the maker confirms the fix worked.
   *
   * Distinct from {@link fix}: that is the change to make, this is the test that proves it landed.
   * The AI workflow returns both on every finding, and a reader given only the change has no way
   * to tell whether they have finished.
   */
  acceptanceCheck?: string;
  /** Ordered remediation steps, where the rule or the model supplied them. */
  fixSteps?: readonly string[];
  /** The model's own confidence. Absent on every deterministic finding. */
  confidence?: 'high' | 'medium' | 'low';
  /** Replacement text the maker can paste, when one applies. */
  suggestedText?: string;
  /** Where in the captured subject the fact was read, e.g. `bot.configuration`. */
  fieldPath?: string;
  referenceId?: string;
  /** True when an AI model produced this finding rather than a deterministic rule. */
  ai: boolean;
  componentIdUnique?: string;
}

/** Component categories ART inventories, in the order the UI shows them. */
export type ComponentKind =
  | 'tool'
  | 'skill'
  | 'knowledge'
  | 'connected-agent'
  | 'topic'
  | 'trigger'
  | 'test-case';

export const COMPONENT_KIND_LABELS: Record<ComponentKind, string> = {
  tool: 'Tools',
  skill: 'Skills',
  knowledge: 'Knowledge',
  'connected-agent': 'Connected agents',
  topic: 'Topics',
  trigger: 'Triggers',
  'test-case': 'Test cases',
};

/** A single inventoried component. */
export interface ArtComponent {
  kind: ComponentKind;
  name: string;
  /** ART's own sub-type, e.g. `ConnectorTool`, `SharePointKnowledgeSource`. */
  subKind?: string;
  componentIdUnique?: string;
  /** Connected agents only — needed to resolve the child bot record. */
  botSchemaName?: string;
}

/** A connected (child) agent referenced by the reviewed agent. */
export interface ArtConnectedAgent {
  name: string;
  botSchemaName?: string;
  componentIdUnique?: string;
}

/**
 * The five instruction elements Microsoft's authoring guidance lists, in ART's order.
 *
 * ART does not persist this grid — it derives it from findings, so we must derive it the same way or
 * the two reports will disagree about the same review. See `parseInstructionCoverage`.
 */
export const INSTRUCTION_ELEMENT_KEYS = [
  'role',
  'tone',
  'boundaries',
  'ambiguity',
  'escalation',
] as const;

export type InstructionElementKey = (typeof INSTRUCTION_ELEMENT_KEYS)[number];

export const INSTRUCTION_ELEMENT_LABELS: Record<InstructionElementKey, string> = {
  role: 'Role & purpose',
  tone: 'Tone & style',
  boundaries: 'Decline/redirect boundaries',
  ambiguity: 'Ambiguous-input handling',
  escalation: 'Escalation triggers',
};

/** One instruction element and whether the review found it stated. */
export interface ArtInstructionElement {
  key: InstructionElementKey;
  label: string;
  present: boolean;
}

/**
 * Whether the AI classifier that judges instruction coverage actually ran.
 *
 * Kept apart from the elements themselves because "the classifier never ran" and "the classifier ran
 * and found everything" are different facts. Collapsing them would report an unprovisioned environment
 * as a clean bill of health.
 */
export interface ArtInstructionCoverage {
  /** Raw state from `analysisStatus.instructionCoverage`, e.g. `complete`, `unavailable`. */
  state: string;
  reason?: string;
  /** ART's own wording for the state, so both reports read identically. */
  label: string;
  /** True when the classifier completed; the element grid is only meaningful then. */
  evaluated: boolean;
  elements: ArtInstructionElement[];
}

/** One capability and how many evaluation cases exercise it. */
export interface ArtCoverageRow {
  name: string;
  kind: string;
  cases: number;
}

/**
 * How ART mapped evaluation cases to capabilities.
 *
 * `declared` means the cases name the capability they exercise, so a zero is a real gap. `inferred`
 * means ART matched by name, so a zero can equally mean "we could not tell" — the distinction has to
 * travel with the numbers or the coverage table reads as more certain than it is.
 */
export type ArtCoverageBasis = 'declared' | 'inferred';

/** An evaluation set and how much of the agent's capability surface it covers. */
export interface ArtCoverageSet {
  name: string;
  caseCount: number;
  declaringCases: number;
  covered: number;
  total: number;
}

/** One cross-skill orchestration pattern. Agent-level: no single skill owns it. */
export interface ArtOrchestrationFinding {
  id: string;
  ruleId: string;
  type: string;
  severity: ArtSeverity;
  title: string;
  skills: string[];
  evidence?: string;
  rationale?: string;
  recommendation?: string;
}

/** Cross-skill orchestration, evaluated once per review across the whole skill set. */
export interface ArtOrchestration {
  status: string;
  summary?: string;
  findings: ArtOrchestrationFinding[];
}

/**
 * How the score was arrived at, so a number is never quoted without its provenance.
 *
 * A legacy (v1) score and a partial v2 score are both real numbers that mean less than they appear
 * to, and printing a bare `88/100` for either overstates the review. `label` is ART's own wording so a
 * reader comparing the two reports never sees the same score described two ways.
 */
export interface ArtScoreBasis {
  version?: number;
  status?: string;
  label: string;
}

/** One agent's ART review, flattened to what the UI needs. */
export interface ArtReview {
  reviewId: string;
  botId: string;
  botName: string;
  /**
   * ART's rolled-up 0-100 score for this agent, or `null` when it withheld one.
   *
   * Nullable for the same reason as {@link ArtPillar.score}: ART omits `cat_overallscore` entirely
   * when the composite could not be measured, and `Number(undefined)` is not a number while
   * `Number(null)` is a finite `0`. Defaulting here would report an unexamined agent as having
   * scored zero, and an average over it would pull a real score down rather than stepping aside.
   */
  score: number | null;
  reviewDate: string;
  sourceEnvironment?: string;
  pillars: ArtPillar[];
  findings: ArtFinding[];
  /**
   * Every rule that ran, including the ones that passed in silence.
   *
   * Empty on reviews saved before ART persisted them; the consolidated list falls back to a notice
   * rather than presenting a findings-only view as if it were the whole result.
   */
  ruleResults: ArtRuleResult[];
  /**
   * The `agentsExperience` payload exactly as ART wrote it.
   *
   * Everything else on this interface is a flattened projection shaped for one screen. The agent map
   * is not a projection — it is ART's own component, and it reads the whole model: which skill
   * reaches which tool, which capability a step names, which connected agent answers. Re-flattening
   * that into local types would be a second copy of ART's model, free to drift from the one the map
   * was written against, so the payload is carried through untouched instead.
   *
   * Absent on a standard or skill review, neither of which produces this payload.
   */
  displayPayload?: CopilotReviewDisplayPayload;
  /**
   * What the review workflow actually returned, on a standard review.
   *
   * A rule the workflow never answered for is saved as not-assessed, and the findings list shows
   * that as "Not assessed" — the same words it uses for a rule that genuinely had nothing to
   * judge. The two are indistinguishable once they are in the list, so without this record a review
   * where the workflow never ran at all reads as a review where every rule happened not to apply.
   *
   * Absent on reviews saved before it was recorded, and on copilot and skill reviews, neither of
   * which runs the standard workflow.
   */
  workflowProvenance?: StandardReviewWorkflowProvenance;
  components: ArtComponent[];
  connectedAgents: ArtConnectedAgent[];
  /** Undefined on reviews written before ART persisted `analysisStatus`. */
  instructionCoverage?: ArtInstructionCoverage;
  /** Per-capability evaluation coverage, and how it was established. */
  coverage: ArtCoverageRow[];
  coverageBasis: ArtCoverageBasis;
  coverageSets: ArtCoverageSet[];
  /** Undefined when the orchestration evaluator was not provisioned for the review. */
  orchestration?: ArtOrchestration;
  /** Provenance of `score`. Always present; `label` degrades to a legacy warning on old reviews. */
  scoreBasis: ArtScoreBasis;
  /**
   * `deep` when ART fetched each skill's resources, `standard` when it could not.
   *
   * A standard review inspects far less, so its clean result is weaker evidence. Carrying the mode is
   * the only way a reader can tell the two apart.
   */
  skillReviewMode?: string;
  /**
   * The agent's own configuration at the moment it was reviewed: which model series it runs, and
   * whether memory and web search are on.
   *
   * Only the GitHub Copilot harness records `agentSettings`, so all three stay undefined on a
   * standard or skill review. Left undefined rather than defaulted, because "web search is off" and
   * "we never captured whether web search is on" are different statements and the summary bar shows
   * the row only for the first.
   */
  modelSeries?: string;
  memoryEnabled?: boolean;
  webSearchEnabled?: boolean;
  /** How long the review run took, in milliseconds. Absent on rows saved before ART recorded it. */
  durationMs?: number;
  counts: {
    passed: number;
    warnings: number;
    errors: number;
    evaluated: number;
  };
  /** False when the row exists but its JSON could not be understood. */
  parsed: boolean;
}

/**
 * One agent in an aggregated review — the chosen agent plus any connected
 * agents. `review` is undefined when that agent has never been reviewed.
 */
export interface AggregatedAgent {
  botId?: string;
  botName: string;
  isRoot: boolean;
  review?: ArtReview;
  /**
   * The uploaded-artifact review, when this agent is a skill rather than a Copilot Studio agent.
   *
   * A skill snapshot stores ART's `ArtifactReviewResult` in the same `cat_reviewresultjson` column
   * an agent review uses, but the two are different shapes reporting different things: an agent has
   * pillars, components and connected agents, while an artifact has rubric dimensions, per-runtime
   * verdicts and the files that were read. Forcing one into the other would either invent fields or
   * silently drop the half the skill rubric actually scores, so they sit side by side and the panel
   * renders whichever is present.
   */
  artifactReview?: ArtifactReviewResult;
  /**
   * The declarative-agent review, when this subject is an uploaded M365 DA package.
   *
   * A third shape beside the other two for the same reason they are two: a DA is graded on ART's
   * own six-criterion DA rubric — instructions, knowledge, capabilities, actions, conversation
   * starters, error handling — with a separate list of manifest-level package rules. It has
   * neither the agent's pillars nor the skill's rubric dimensions, so it gets its own slot and the
   * panel renders whichever is present.
   */
  declarativeAgentReview?: DeclarativeAgentReview;
  /** Populated when a connected agent could not be resolved to a bot record. */
  unresolvedReason?: string;
}

/**
 * A stored declarative-agent review, as the results screen needs it.
 *
 * The score is kept beside the payload rather than read out of it because ART writes it to the
 * `cat_overallscore` column and not into `cat_reviewresultjson` — recomputing it here would mean
 * reimplementing ART's DA weighting, which is exactly what this app does not do.
 */
export interface DeclarativeAgentReview {
  /** `cat_overallscore`. Null when the rubric could assess nothing and withheld a number. */
  score: number | null;
  /** `cat_reviewresultjson`, parsed by ART's own reader. */
  data: DAStoredReviewData;
}

/** The whole picture the results screen renders. */
export interface AggregatedReview {
  agents: AggregatedAgent[];
  /** Mean of every reviewed agent's score, or null when none are reviewed. */
  rolledUpScore: number | null;
  reviewedCount: number;
  totalCount: number;
}

/**
 * The score to report for one reviewed subject, whichever kind of review produced it.
 *
 * ART owns both numbers: an agent review stores its rolled-up score on the row, and an artifact
 * review derives one from its assessed dimensions. `overallScoreOf` returns 0 for an artifact
 * nothing could be assessed on, so `hasScore` gates it — reporting that 0 would turn "not assessed"
 * into a judgement nobody made.
 */
export function agentScore(agent: AggregatedAgent): number | undefined {
  if (typeof agent.review?.score === 'number') return agent.review.score;
  if (agent.artifactReview && hasScore(agent.artifactReview)) return overallScoreOf(agent.artifactReview);
  if (typeof agent.declarativeAgentReview?.score === 'number') return agent.declarativeAgentReview.score;
  return undefined;
}

/** Whether this subject was actually reviewed, by either rubric. */
export function isReviewed(agent: AggregatedAgent): boolean {
  return Boolean(agent.review ?? agent.artifactReview ?? agent.declarativeAgentReview);
}

/**
 * Rolled-up score across agents.
 *
 * A simple mean, per the explicit instruction "mean is good if there are
 * multiple agents". Unreviewed agents are excluded rather than counted as zero:
 * a connected agent nobody has reviewed is unknown, not bad, and scoring it as
 * zero would make adding an agent look like a regression.
 */
export function aggregateScore(agents: readonly AggregatedAgent[]): number | null {
  const scores = agents
    .map((agent) => agentScore(agent))
    .filter((score): score is number => typeof score === 'number');

  if (scores.length === 0) return null;
  return Math.round(scores.reduce((total, score) => total + score, 0) / scores.length);
}

/**
 * Recomputes the rolled-up score from pillars.
 *
 * Used only to sanity-check ART's own number in tests — the UI shows what ART
 * stored. Weights sum to 100, so this is a plain weighted average.
 *
 * Legacy blend rows are included deliberately: their two weights also sum to 100, and excluding
 * them would make a pre-refactor review's score unreproducible rather than merely old.
 */
export function scoreFromPillars(pillars: readonly ArtPillar[]): number | null {
  // A withheld pillar leaves the denominator as well as the numerator, which is what ART's own
  // scorer does — keeping its weight would divide a measured total by an unmeasured one.
  const applicable = pillars.filter((pillar) => pillar.applicable && pillar.score !== null);
  const totalWeight = applicable.reduce((total, pillar) => total + pillar.weight, 0);
  if (totalWeight === 0) return null;

  const weighted = applicable.reduce(
    (total, pillar) => total + (pillar.score ?? 0) * pillar.weight,
    0,
  );
  return Math.round(weighted / totalWeight);
}

/**
 * The rows that name a real pillar, with the legacy blend label dropped.
 *
 * The filter is what makes a row safe to hand to ART's scorer. A legacy row cannot be rescored —
 * there is no `'Patterns'` entry in any weight table — so passing one through would not produce a
 * wrong number, it would produce a quietly missing one.
 */
export function scoredPillars(
  pillars: readonly ArtPillar[],
): (Omit<ArtPillar, 'name'> & { name: LegacyPillarName })[] {
  return pillars.flatMap((pillar) =>
    pillar.name === LEGACY_BLEND_PILLAR ? [] : [{ ...pillar, name: pillar.name }],
  );
}

/** Findings for one component, worst first. */
export function findingsForComponent(
  findings: readonly ArtFinding[],
  componentIdUnique: string | undefined,
): ArtFinding[] {
  if (!componentIdUnique) return [];
  return findings
    .filter((finding) => finding.componentIdUnique === componentIdUnique)
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
}

/** A finding group as the Findings tab renders it. */
export interface FindingGroup {
  key: string;
  label: string;
  findings: ArtFinding[];
  highCount: number;
}

/**
 * Groups findings by family, worst-first within each group and across groups.
 *
 * Family rather than component because most findings are agent-level and carry
 * no `componentIdUnique`; grouping strictly by component would strand them in
 * an "other" bucket larger than the real groups.
 */
export function groupFindings(findings: readonly ArtFinding[]): FindingGroup[] {
  const byFamily = new Map<string, ArtFinding[]>();

  for (const finding of findings) {
    const family = finding.family || 'Other';
    const bucket = byFamily.get(family);
    if (bucket) bucket.push(finding);
    else byFamily.set(family, [finding]);
  }

  return Array.from(byFamily, ([label, group]) => {
    const sorted = [...group].sort((a, b) => severityRank(a.severity) - severityRank(b.severity));
    return {
      key: label,
      label,
      findings: sorted,
      highCount: sorted.filter((finding) => finding.severity === 'error').length,
    };
  }).sort((a, b) => {
    const worst = severityRank(a.findings[0]?.severity ?? 'info') -
      severityRank(b.findings[0]?.severity ?? 'info');
    return worst !== 0 ? worst : b.findings.length - a.findings.length;
  });
}
