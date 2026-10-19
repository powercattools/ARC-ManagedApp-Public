/**
 * Reads Agent Review Tool (ART) results.
 *
 * This app does not score anything. ART owns the rubric, runs the AI stages and
 * persists the outcome; here we read that outcome and present it. Re-deriving a
 * score would mean maintaining a second copy of a rubric that is still moving.
 *
 * Two environments are in play and they are not the same one:
 *
 * - **Results** live in `cat_agentreviews` in the environment ART itself runs
 *   in — the current organization. `cat_sourceenvironment` merely *names* where
 *   the agent came from.
 * - **Agents** (`bots`) live in the reviewed environment, which is the review's
 *   `environmentUrl`.
 *
 * Verified against a live review in Copilot Studio Kit - Dev on 2026-08-25:
 * the child agent `cr306_zavastoreopsassistant_lmpyHR` of `ZAVA Visual
 * Merchandiser` is absent from kit-dev's `bots` table precisely because that
 * agent lives in "Power CAT Explore".
 */

import { MicrosoftDataverseService, getHostContext } from '../../../data';
import type { StandardReviewWorkflowProvenance } from '../engine/scoring/art-ports';
import {
  type AggregatedAgent,
  type AggregatedReview,
  type ArtComponent,
  type ArtConnectedAgent,
  type ArtCoverageRow,
  type ArtCoverageSet,
  type ArtFinding,
  type ArtInstructionCoverage,
  type ArtOrchestration,
  type ArtOrchestrationFinding,
  type ArtPillar,
  type ArtReview,
  type ArtRuleResult,
  type ArtScoreBasis,
  type ArtSeverity,
  type DeclarativeAgentReview,
  type InstructionElementKey,
  INSTRUCTION_ELEMENT_KEYS,
  INSTRUCTION_ELEMENT_LABELS,
  aggregateScore,
  isReviewed,
} from '../models/art';
import {
  COMPLIANCE_CRITERIA,
  getIssueCriterionId,
  getInstructionAssessments,
  getPatternAssessment,
  getPatternTopicAssessment,
  resolveStandardRuleId,
  ruleKey,
  AGENT_TYPE,
  parseDAReviewResult,
  type ArtifactReviewResult,
  type ComplianceIssue,
  LEGACY_PILLAR_NAME,
  toAgentPillar,
  type CopilotReviewDisplayPayload,
  type InstructionEvaluation,
  type PatternTopic,
} from '../engine/scoring/art-ports';
import { SKILL_SUBJECT_PREFIX } from '../engine/harnesses/skill/skill-identity';

/** Sentinel for "the environment this app is running in". */
export const CURRENT_ORGANIZATION = 'current';

/**
 * Resolve a stored environment URL to something `new URL` accepts.
 *
 * Reviews record the `'current'` sentinel when the user picks "(Current)" from the dropdown, so any
 * caller that parses the stored value has to translate it first. An empty value is treated the same
 * way: an orchestrated snapshot cannot exist without an environment, so the app's own is the only
 * environment it can mean, and origin comparison still rejects anything genuinely foreign.
 */
export function resolveOrganizationUrl(environmentUrl: string | undefined, organizationUrl: string): string {
  if (!environmentUrl || environmentUrl.toLowerCase() === CURRENT_ORGANIZATION) return organizationUrl;
  return environmentUrl;
}

/**
 * Whether two environment URLs name the same environment.
 *
 * Origins, not strings: the same environment is reachable by more than one spelling, and a stored
 * URL may carry a path or trailing slash the picker's copy does not.
 */
export function isSameOrganization(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    // An unparseable URL names nothing we can match.
    return false;
  }
}

/**
 * Whether an environment URL names the environment this app is running in.
 *
 * `GetOrganizations` returns the current environment twice: once as the literal `current` sentinel,
 * and once by its real URL among the rest. Matching only the sentinel would call an environment
 * "somewhere else" because of how it was picked from a dropdown, so the origins are compared too.
 *
 * This matters beyond cosmetics: runtime analysis runs in this environment only, and the verdict
 * decides whether a job row is created at all.
 */
export async function isCurrentEnvironment(environmentUrl: string | undefined): Promise<boolean> {
  if (!environmentUrl) return false;
  if (environmentUrl.toLowerCase() === CURRENT_ORGANIZATION) return true;
  try {
    const { organizationUrl } = await artService.linkContext();
    return isSameOrganization(environmentUrl, organizationUrl);
  } catch {
    // An environment we cannot resolve is not the current one.
    return false;
  }
}

/**
 * Logical name of the code app hosting the Agent Review Tool, so results can be
 * opened in the tool that produced them.
 *
 * Looked up by logical name rather than by GUID: every solution import assigns
 * a canvas app a fresh `canvasappid`, so a written-down GUID is only ever
 * correct in the environment it was read from. The logical name travels with
 * the solution and is the same in every install.
 */
const ART_APP_LOGICAL_NAME = 'cat_copilotstudiokitformakers_60c9a';

/**
 * Unique name of the model-driven app that hosts the Agent Review Tool. Looked
 * up by unique name rather than by GUID because the GUID differs per install.
 */
const KIT_APP_UNIQUE_NAME = 'cat_CopilotStudioAccelerator';

/**
 * See `environment-service`: every header argument must be an explicit value.
 * An omitted argument is serialised as the literal string `"undefined"`, which
 * makes the connector policy fail `Boolean.Parse` and return HTTP 500.
 */
const HEADERS = ['', 'application/json', false, false] as const;

/** Light columns — deliberately excludes the ~50 KB result JSON. */
const REVIEW_INDEX_COLUMNS =
  'cat_agentreviewsid,cat_botid,cat_botname,cat_overallscore,cat_reviewdate,cat_sourceenvironment,' +
  'cat_patternscore,cat_instructionscore';

interface ReviewIndexRow {
  cat_agentreviewsid?: string;
  cat_botid?: string;
  cat_botname?: string;
  cat_overallscore?: number | string;
  cat_reviewdate?: string;
  cat_sourceenvironment?: string;
  /** Standard reviews only — the two halves of the 50/50 rubric, as persisted. */
  cat_patternscore?: number | string;
  cat_instructionscore?: number | string;
}

interface BotRow {
  botid?: string;
  name?: string;
  schemaname?: string;
}

function valuesOf<T>(result: unknown): T[] {
  const data = (result as { data?: { value?: T[] } } | undefined)?.data;
  return Array.isArray(data?.value) ? data.value : [];
}

function describeError(result: { error?: unknown; data?: unknown }): string {
  const raw = result.error ?? result.data;
  if (typeof raw === 'object' && raw !== null) {
    const outer = raw as { message?: string; error?: { message?: string } };
    if (outer.error?.message) return outer.error.message;
    if (outer.message) return outer.message;
  }
  return 'The environment did not answer.';
}

async function list<T>(
  organization: string,
  entityName: string,
  select: string,
  filter?: string,
  top?: number,
): Promise<T[]> {
  const result = await MicrosoftDataverseService.ListRecordsWithOrganization(
    organization,
    entityName,
    ...HEADERS,
    select,
    filter,
    // $orderby, $expand and fetchXml must be omitted entirely — an empty string
    // is sent as an empty query option and Dataverse rejects it.
    undefined,
    undefined,
    undefined,
    top,
  );

  if (!result.success) throw new Error(describeError(result));
  return valuesOf<T>(result);
}

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A number, or `null` when the payload carried none.
 *
 * Distinct from {@link num} because a withheld score and a measured zero are different claims:
 * `Number(null)` is a finite `0`, so the plain parse cannot tell them apart.
 */
function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** OData string literals escape a single quote by doubling it. */
function odataLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

/** ART emits lowercase severities; anything unrecognised is treated as info. */
function toSeverity(value: unknown): ArtSeverity {
  const text = String(value ?? '').toLowerCase();
  if (text === 'error' || text === 'critical' || text === 'high') return 'error';
  if (text === 'warning' || text === 'warn' || text === 'medium') return 'warning';
  return 'info';
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parsePillars(raw: unknown): ArtPillar[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const rawName = str(row.pillar) ?? str(row.name);
    // Normalised rather than passed through: rows have been written in both casings, and a name the
    // rubric does not know cannot be weighted by it, so it is dropped instead of scored as nothing.
    const pillar = rawName ? toAgentPillar(rawName) : undefined;
    if (!pillar) return [];
    return [
      {
        name: LEGACY_PILLAR_NAME[pillar],
        weight: num(row.weight),
        // Preserved rather than defaulted: ART writes `null` for a pillar it withheld, and that is
        // the only signal separating "could not be measured" from "scored nothing".
        score: numOrNull(row.score),
        // Absent means applicable — ART only sets this flag to exclude a pillar.
        applicable: row.applicable !== false,
        complete: row.complete !== false,
      },
    ];
  });
}

/**
 * Ordered remediation steps.
 *
 * Accepts both shapes the payload has carried: a plain list of sentences, and the richer
 * `{ order, action }` rows the AI workflow emits. Sorting by `order` rather than trusting array
 * order matters only for the second, where the node is free to return them unsorted.
 */
function strArray(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const steps = raw
    .map((entry, index) => {
      if (typeof entry === 'string') return { order: index, action: entry.trim() };
      if (typeof entry === 'object' && entry !== null) {
        const row = entry as Record<string, unknown>;
        const order = typeof row.order === 'number' && Number.isFinite(row.order) ? row.order : index;
        return { order, action: str(row.action) ?? '' };
      }
      return { order: index, action: '' };
    })
    .filter(s => s.action.length > 0)
    .sort((a, b) => a.order - b.order)
    .map(s => s.action);
  return steps.length ? steps : undefined;
}

const CONFIDENCE = new Set(['high', 'medium', 'low']);

function toConfidence(raw: unknown): 'high' | 'medium' | 'low' | undefined {
  const value = str(raw)?.toLowerCase();
  return value && CONFIDENCE.has(value) ? (value as 'high' | 'medium' | 'low') : undefined;
}

function parseFindings(raw: unknown): ArtFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const title = str(row.title);
    if (!title) return [];
    return [
      {
        id: str(row.id) ?? `finding-${index}`,
        family: str(row.family) ?? 'Other',
        severity: toSeverity(row.severity),
        title,
        fact: str(row.fact),
        why: str(row.why),
        fix: str(row.fix),
        acceptanceCheck: str(row.acceptanceCheck),
        fixSteps: strArray(row.fixSteps),
        confidence: toConfidence(row.confidence),
        suggestedText: str(row.suggestedText),
        fieldPath: str(row.fieldPath),
        referenceId: str(row.referenceId),
        ai: row.ai === true,
        componentIdUnique: str(row.componentIdUnique),
      },
    ];
  });
}

/**
 * Reads `agentsExperience.ruleResults` — the outcome of every rule that ran.
 *
 * Unknown statuses are dropped rather than coerced. A status we cannot read would otherwise have to
 * be guessed into a bucket, and guessing it into `passed` reports a result the review never gave.
 */
function parseRuleResults(raw: unknown): ArtRuleResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const ruleId = str(row.ruleId);
    const status = str(row.status);
    if (!ruleId || !status || !RULE_STATUSES.has(status)) return [];
    return [
      {
        key: str(row.key) ?? `${ruleId}-${index}`,
        ruleId,
        family: str(row.family) ?? 'Other',
        status: status as ArtRuleResult['status'],
        subject: str(row.subject),
        subjectId: str(row.subjectId),
        kind: row.kind === 'record' ? ('record' as const) : undefined,
        // Both are declared on the contract and were never read, so a standard harness's own
        // `PatternName` never reached its row and every not-assessed row showed the generic
        // "this rule could not be evaluated" in place of the harness's actual reason.
        title: str(row.title),
        note: str(row.note),
      },
    ];
  });
}

const RULE_STATUSES = new Set([
  'passed', 'info', 'warning', 'error', 'not-applicable', 'failed',
]);

/**
 * Reads one component category out of `agentsExperience.model`.
 *
 * Entries are objects in every sample seen, but a bare string is tolerated
 * because these arrays are shaped by whatever the agent author authored.
 */
function parseComponents(
  raw: unknown,
  kind: ArtComponent['kind'],
  subKindKey?: string,
): ArtComponent[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry === 'string') return [{ kind, name: entry }];
    if (typeof entry !== 'object' || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const name = str(row.name) ?? str(row.skillName) ?? str(row.displayName);
    if (!name) return [];
    return [
      {
        kind,
        name,
        subKind: subKindKey ? str(row[subKindKey]) : undefined,
        componentIdUnique: str(row.componentIdUnique),
        botSchemaName: str(row.botSchemaName),
      },
    ];
  });
}

function parseConnectedAgents(raw: unknown): ArtConnectedAgent[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const name = str(row.name);
    if (!name) return [];
    return [
      {
        name,
        botSchemaName: str(row.botSchemaName),
        componentIdUnique: str(row.componentIdUnique),
      },
    ];
  });
}

/**
 * Rebuilds the five-element instruction grid from findings.
 *
 * ART does not persist the grid; its own export derives it by looking for a quoted element key in the
 * `fact` of an `Instructions` finding, because a missing element is recorded as
 * `element "role" not found in instructions`. We deliberately mirror that rule rather than inventing a
 * better one: both reports describe the same review, and a private heuristic would let them disagree.
 *
 * Deriving from the finding id would look tidier and is not usable — the positive "covers all five"
 * finding reuses `INS-02`, the same id as the "role is missing" rule, so the id alone cannot tell the
 * two apart.
 *
 * The grid is only meaningful when the classifier completed. A review where it never ran has no
 * missing-element findings, which would otherwise render as five ticks — a clean bill of health issued
 * by a check that never happened.
 */
function parseInstructionCoverage(
  analysisStatus: unknown,
  findings: ArtFinding[],
): ArtInstructionCoverage | undefined {
  if (typeof analysisStatus !== 'object' || analysisStatus === null) return undefined;
  const status = (analysisStatus as Record<string, unknown>).instructionCoverage;
  if (typeof status !== 'object' || status === null) return undefined;

  const row = status as Record<string, unknown>;
  const state = str(row.state) ?? 'unknown';
  const evaluated = state === 'complete';

  const missing = new Set<InstructionElementKey>();
  for (const finding of findings) {
    if (finding.family !== 'Instructions' || !finding.fact) continue;
    for (const key of INSTRUCTION_ELEMENT_KEYS) {
      if (finding.fact.includes(`"${key}"`)) missing.add(key);
    }
  }

  return {
    state,
    reason: str(row.reason),
    label: instructionCoverageLabel(state),
    evaluated,
    elements: INSTRUCTION_ELEMENT_KEYS.map((key) => ({
      key,
      label: INSTRUCTION_ELEMENT_LABELS[key],
      present: !missing.has(key),
    })),
  };
}

/** ART's own wording, so the two reports never describe the same state differently. */
function instructionCoverageLabel(state: string): string {
  switch (state) {
    case 'complete':
      return 'Complete';
    case 'partial':
      return 'Partial';
    case 'unavailable':
      return 'Not evaluated (classifier unavailable)';
    case 'not-applicable':
      return 'Not applicable (no instructions)';
    case 'failed':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Unknown';
  }
}

function parseCoverage(raw: unknown): ArtCoverageRow[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const name = str(row.name);
    if (!name) return [];
    return [{ name, kind: str(row.kind) ?? 'Capability', cases: num(row.cases) }];
  });
}

function parseCoverageSets(raw: unknown): ArtCoverageSet[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const name = str(row.name);
    if (!name) return [];
    return [
      {
        name,
        caseCount: num(row.caseCount),
        declaringCases: num(row.declaringCases),
        covered: num(row.covered),
        total: num(row.total),
      },
    ];
  });
}

/**
 * Cross-skill orchestration findings.
 *
 * Agent-level by construction: these describe how skills interact, so no single skill owns them and
 * they never appear in the per-skill findings list. Omitting them would silently drop a whole class of
 * finding from our report that ART's own PDF shows.
 */
function parseOrchestration(raw: unknown): ArtOrchestration | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const row = raw as Record<string, unknown>;

  const findings: ArtOrchestrationFinding[] = Array.isArray(row.findings)
    ? row.findings.flatMap((entry) => {
        if (typeof entry !== 'object' || entry === null) return [];
        const f = entry as Record<string, unknown>;
        const title = str(f.title);
        if (!title) return [];
        return [
          {
            id: str(f.id) ?? '',
            ruleId: str(f.ruleId) ?? '',
            type: str(f.type) ?? '',
            severity: toSeverity(f.severity),
            title,
            skills: Array.isArray(f.skills)
              ? f.skills.flatMap((s) => (typeof s === 'string' ? [s] : []))
              : [],
            evidence: str(f.evidence),
            rationale: str(f.rationale),
            recommendation: str(f.recommendation),
          },
        ];
      })
    : [];

  return { status: str(row.status) ?? 'unknown', summary: str(row.summary), findings };
}

/**
 * Score provenance, using ART's exact wording.
 *
 * A review with no `basisVersion` was scored by the old v1 rules, whose numbers are not comparable to
 * v2's, and a `partial` v2 score means some rules never ran. Both are still shown — suppressing a
 * score because it is imperfect would be worse — but neither is shown bare.
 */
function parseScoreBasis(score: Record<string, unknown>): ArtScoreBasis {
  const version = typeof score.basisVersion === 'number' ? score.basisVersion : undefined;
  const status = str(score.status);

  if (version === undefined) {
    return { version, status, label: 'Legacy score (basis version 1). Rerun recommended' };
  }
  return {
    version,
    status,
    label:
      status === 'partial'
        ? 'Grounded configuration score (v2): partial'
        : 'Grounded configuration score (v2)',
  };
}

/* ------------------------------------------------------ standard (classic) harness */

/**
 * Stage A's deterministic rules carry these ids; everything else in the pattern list came from the
 * Stage B model. The distinction drives the "AI" badge, so it must not be guessed.
 */
const LOCAL_PATTERN_PREFIX = 'local-pattern-';
const OVERLAPPING_TOPIC_DESCRIPTIONS = 'overlapping topic descriptions';

interface ProjectedPatternFinding {
  topic: PatternTopic;
  finding: ArtFinding;
}

/**
 * ART records one entry per affected setting. When a model writes one shared title for several
 * settings, its drawer still shows the component beside that title; ARW's compact evidence list
 * has no separate component field, so add that context only where the saved titles collide.
 */
function contextualizeRepeatedPatternFacts(
  projected: readonly ProjectedPatternFinding[],
): ArtFinding[] {
  const occurrences = new Map<string, number>();
  for (const { finding } of projected) {
    if (!finding.fact) continue;
    occurrences.set(finding.fact, (occurrences.get(finding.fact) ?? 0) + 1);
  }

  return projected.map(({ topic, finding }) =>
    finding.fact && (occurrences.get(finding.fact) ?? 0) > 1
      ? { ...finding, fact: `${topic.item}: ${finding.fact}` }
      : finding);
}

/**
 * Overlap evidence describes a relationship, so ART can persist the same pair-level remediation on
 * both participant rows. ARW renders a flat evidence list rather than ART's side-by-side comparison;
 * collapse only presentation-identical copies while keeping genuinely different overlap pairs.
 */
function collapseRepeatedOverlapFacts(
  projected: readonly ProjectedPatternFinding[],
): ArtFinding[] {
  const collapsed: ArtFinding[] = [];
  const indexByEvidence = new Map<string, number>();

  for (const { finding } of projected) {
    const evidenceKey = JSON.stringify([
      finding.fact ?? '',
      finding.why ?? '',
      finding.fix ?? '',
      finding.referenceId ?? '',
    ]);
    const existingIndex = indexByEvidence.get(evidenceKey);
    if (existingIndex === undefined) {
      indexByEvidence.set(evidenceKey, collapsed.length);
      collapsed.push({ ...finding });
      continue;
    }

    const existing = collapsed[existingIndex];
    if (existing?.componentIdUnique !== finding.componentIdUnique) {
      delete existing?.componentIdUnique;
    }
  }

  return collapsed;
}

/**
 * Failed Stage B patterns, as findings.
 *
 * Passing patterns are deliberately dropped. They are real evidence and they belong in the counts
 * below, but a findings list is a list of things to act on; folding eleven ticks into it would bury
 * the three that matter.
 */
function parsePatternFindings(raw: unknown): ArtFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const assessment = getPatternAssessment(row);
    if (assessment !== 'fail') return [];

    const title = str(row.PatternName);
    if (!title) return [];

    const patternId = str(row.PatternId) ?? `pattern-${index}`;
    // Must match the rule result's `ruleId`. `buildConsolidatedView` attaches findings to rule
    // outcomes by rule id, so a finding left on the raw pattern id would detach from the rule that
    // resolved, and render as a second row carrying all the detail but none of the score credit.
    const id = resolveStandardRuleId(patternId);
    const description = str(row.Description) ?? str(row.PatternDescription);
    const recommendation = str(row.Recommendation);
    const severity = toSeverity(row.Severity);
    const ai = !patternId.startsWith(LOCAL_PATTERN_PREFIX);
    const topics = Array.isArray(row.Topics)
      ? row.Topics.flatMap((topic): PatternTopic[] => {
          if (typeof topic === 'string') return [{ item: topic }];
          if (typeof topic !== 'object' || topic === null) return [];
          return str((topic as Record<string, unknown>).item)
            ? [topic as PatternTopic]
            : [];
        })
      : [];
    const failedTopics = topics.filter(topic =>
      getPatternTopicAssessment(assessment, topic) === 'fail');

    if (failedTopics.length) {
      const projected = failedTopics.map((topic): ProjectedPatternFinding => {
        const topicRecord = topic as unknown as Record<string, unknown>;
        const remediation = asRecord(topicRecord.remediation);
        const current = str(topicRecord.current);
        const fact = str(remediation?.findingTitle)
          ?? (current ? `${topic.item}: ${current}` : topic.item);

        return {
          topic,
          finding: {
            id,
            family: str(row.Category) ?? 'Patterns',
            severity,
            title,
            fact,
            ...(str(remediation?.whyItMatters) ? { why: str(remediation?.whyItMatters) } : {}),
            ...(str(remediation?.makerAction) || recommendation
              ? { fix: str(remediation?.makerAction) ?? recommendation }
              : {}),
            ai,
            ...(str(topicRecord.componentId)
              ? { componentIdUnique: str(topicRecord.componentId) }
              : {}),
          },
        };
      });

      return title.trim().toLocaleLowerCase() === OVERLAPPING_TOPIC_DESCRIPTIONS
        ? collapseRepeatedOverlapFacts(projected)
        : contextualizeRepeatedPatternFacts(projected);
    }

    return [
      {
        id,
        family: str(row.Category) ?? 'Patterns',
        severity,
        title,
        ...(description ? { fact: description } : {}),
        ...(recommendation ? { fix: recommendation } : {}),
        ai,
      },
    ];
  });
}

/**
 * Stage C compliance issues, as findings. Every one is AI-authored — Stage C is a single prompt.
 *
 * Newer issues carry a written `title`. Older ones carry nothing but a kebab-case id, and ART falls
 * back to printing it raw (`csPdfUtils.ts`, "const title = issue.title ?? issue.id"). That was
 * tolerable in a findings list read by its author; in the consolidated list, where every row is
 * titled, `out-of-scope-handling-missing` sits between written sentences and reads as a defect in
 * the tool. `humanizeId` only re-cases the identifier ART already chose — the row is still called
 * the same thing, and no wording is invented that the review did not assert.
 */
function humanizeId(id: string): string {
  const words = id.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id;
}

const COMPLIANCE_CRITERION_IDS = new Set(COMPLIANCE_CRITERIA.map(criterion => criterion.id));

function parseComplianceFindings(
  raw: unknown,
  instructionResults?: readonly ArtRuleResult[],
): ArtFinding[] {
  if (!Array.isArray(raw)) return [];
  const resultByCriterion = instructionResults
    ? new Map(instructionResults.map(result => [result.ruleId, result]))
    : undefined;
  return raw.flatMap((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const issueId = str(row.id);
    const criteriaId = resultByCriterion
      ? getIssueCriterionId(row as unknown as ComplianceIssue)
      : str(row.criteriaId);
    const linkedResult = criteriaId ? resultByCriterion?.get(criteriaId) : undefined;
    if (resultByCriterion && linkedResult
      && linkedResult.status !== 'error' && linkedResult.status !== 'warning') {
      return [];
    }
    if (resultByCriterion && str(row.assessmentStatus)
      && str(row.assessmentStatus) !== 'fail') {
      return [];
    }
    const id = resultByCriterion && criteriaId && COMPLIANCE_CRITERION_IDS.has(criteriaId)
      ? criteriaId
      : issueId;
    const title = str(row.title) ?? (issueId ? humanizeId(issueId) : undefined);
    if (!title) return [];

    // The guideline is the citation for the finding, and it is the only thing that says which rule
    // was applied — losing it leaves a criticism with no authority behind it.
    const fact = [str(row.description), str(row.guidelineReference)].filter(Boolean).join(' ');

    return [
      {
        id: id ?? `compliance-${index}`,
        family: str(row.category) ?? 'Instructions',
        severity: toSeverity(row.severity),
        title,
        ...(fact ? { fact } : {}),
        ...(str(row.recommendation) ? { fix: str(row.recommendation) } : {}),
        ai: true,
      },
    ];
  });
}

/**
 * Every persisted instruction criterion, normalized by ART's own compatibility rules.
 *
 * Presence of the property is the format boundary. Older reviews have issues only and keep their
 * historical findings-only projection; a new review with an empty or malformed array is still a
 * new review, and ART conservatively returns "not assessed" for every criterion it cannot confirm.
 */
function parseInstructionRuleResults(
  instructionEvaluation: Record<string, unknown>,
): ArtRuleResult[] | undefined {
  if (!Object.prototype.hasOwnProperty.call(instructionEvaluation, 'criterionAssessments')) {
    return undefined;
  }

  const assessments = getInstructionAssessments(
    instructionEvaluation as unknown as InstructionEvaluation,
  );
  const assessmentById = new Map(assessments.map(assessment => [assessment.criteriaId, assessment]));

  return COMPLIANCE_CRITERIA.map((criterion): ArtRuleResult => {
    const assessment = assessmentById.get(criterion.id);
    const status: ArtRuleResult['status'] =
      assessment?.status === 'pass'
        ? 'passed'
        : assessment?.status === 'fail'
          ? criterion.inherentSeverity === 'High' ? 'error' : 'warning'
          : assessment?.status === 'not-applicable'
            ? 'not-applicable'
            : 'failed';

    return {
      key: ruleKey(criterion.id),
      ruleId: criterion.id,
      family: 'Instructions',
      status,
      title: criterion.name,
      ...(assessment?.reason ? { note: assessment.reason } : {}),
    };
  });
}

/**
 * Every pattern the standard harness ran, as a rule outcome.
 *
 * The classic harness has no `ruleResults` array, but it does not need one: each entry in
 * `patternEvaluation.Patterns` already *is* a rule outcome — it names itself, states a verdict, and
 * carries the reason behind that verdict. Only the failures were being read, which left a standard
 * review looking like a list of complaints with no denominator, exactly the gap the consolidated
 * list exists to close.
 *
 * `AssessmentStatus` is read in preference to `Status`, because the two disagree on purpose. A
 * pattern that could not be judged still reports `Status: false` — "this pattern was not confirmed"
 * — alongside `AssessmentStatus: "not-assessed"` and a reason such as "No completed assessment was
 * returned". Taking the boolean at face value reports the agent as failing a check that never ran.
 * Older reviews predate `AssessmentStatus` entirely; those fall back to the boolean, which is all
 * the evidence they have.
 */
function parseStandardRuleResults(raw: unknown): ArtRuleResult[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const patternId = str(row.PatternId) ?? `pattern-${index}`;
    // The registry keys pillars by the registered id, so an unresolved pattern id scores in no
    // pillar at all. `key` stays the raw pattern id because stored dismissals were recorded
    // against it; resolving it here would silently void every manual pass a maker has saved.
    const ruleId = resolveStandardRuleId(patternId);

    // Severity grades a failure; it says nothing about a pattern that held or never ran.
    const failed = toSeverity(row.Severity) === 'error' ? 'error' : 'warning';
    const assessment = str(row.AssessmentStatus);
    const status: ArtRuleResult['status'] =
      assessment === 'pass'
        ? 'passed'
        : assessment === 'fail'
          ? failed
          : assessment === 'not-applicable'
            ? 'not-applicable'
            : assessment === 'not-assessed'
              ? 'failed'
              : row.Status === true
                ? 'passed'
                : failed;

    return [
      {
        key: patternId,
        ruleId,
        family: str(row.Category) ?? 'Patterns',
        status,
        ...(str(row.PatternName) ? { title: str(row.PatternName) as string } : {}),
        ...(str(row.AssessmentReason) ? { note: str(row.AssessmentReason) as string } : {}),
      },
    ];
  });
}

/**
 * A standard (classic) review, flattened for the same screens the copilot harness uses.
 *
 * The two harnesses persist genuinely different payloads — a classic agent has topics and no skills,
 * and its rubric is two AI prompts rather than a workflow — so this cannot be folded into the
 * agents-experience parser. What it can do is land in the same `ArtReview`, which is why the results
 * screen needs no harness branch of its own.
 *
 * Nothing here recomputes a score. The pattern and instruction halves are read from the row exactly
 * as the engine persisted them; re-deriving them would be a second implementation of ART's rubric,
 * free to drift from the number already shown beside it.
 */
/**
 * The workflow's own record of what it returned, read back as the engine wrote it.
 *
 * A record without `units` is treated as absent rather than as an empty one: reviews saved before
 * provenance was recorded have no record at all, and reporting those as "0 of 0 units returned"
 * would accuse a perfectly good review of having run against a workflow that never answered.
 */
function parseWorkflowProvenance(raw: unknown): StandardReviewWorkflowProvenance | undefined {
  const record = asRecord(raw);
  if (!record || !Array.isArray(record.units) || record.units.length === 0) return undefined;
  return record as unknown as StandardReviewWorkflowProvenance;
}

function parseStandardReview(
  base: ArtReview,
  row: ReviewIndexRow,
  payload: Record<string, unknown>,
): ArtReview {
  const stageA = (payload.stageA ?? {}) as Record<string, unknown>;
  const patternEvaluation = (payload.patternEvaluation ?? {}) as Record<string, unknown>;
  const instructionEvaluation = (payload.instructionEvaluation ?? {}) as Record<string, unknown>;

  const patterns = Array.isArray(patternEvaluation.Patterns) ? patternEvaluation.Patterns : [];
  const issues = Array.isArray(instructionEvaluation.issues) ? instructionEvaluation.issues : [];
  const instructionResults = parseInstructionRuleResults(instructionEvaluation);
  const ruleResults = [
    ...parseStandardRuleResults(patterns),
    ...(instructionResults ?? []),
  ];

  const patternFindings = parsePatternFindings(patterns);
  const complianceFindings = parseComplianceFindings(issues, instructionResults);
  const findings = [...patternFindings, ...complianceFindings];
  const passed = patterns.filter(
    (pattern) =>
      typeof pattern === 'object' &&
      pattern !== null &&
      (pattern as Record<string, unknown>).Status === true,
  ).length;
  const failedPatternRows = patterns.flatMap((pattern): Record<string, unknown>[] => {
    if (typeof pattern !== 'object' || pattern === null) return [];
    const row = pattern as Record<string, unknown>;
    return getPatternAssessment(row) === 'fail' ? [row] : [];
  });

  // Preserved rather than defaulted, for the same reason as `cat_overallscore`: ART omits the
  // column outright when the run could not assess that half (`reviewRecordSerializer.ts` drops the
  // key when `patternScoreApplicable === false`), so `num` would read an absent measurement back as
  // a measured zero and report the agent as having failed a half nothing ever looked at.
  const patternScore = numOrNull(row.cat_patternscore);
  const instructionScore = numOrNull(row.cat_instructionscore);
  // Reviews saved before the standard harness moved onto the shared rubric carry no pillar
  // breakdown, so the old two-pillar shape is reconstructed for them rather than leaving their
  // detail view blank. New reviews read the same persisted breakdown the copilot path reads,
  // through the same parser, so the two harnesses cannot drift apart in this view.
  const persisted = parsePillars(payload.scorePillars);
  const sixPillar = persisted.length > 0 ? persisted : undefined;
  const workflowProvenance = parseWorkflowProvenance(payload.workflowProvenance);

  return {
    ...base,
    parsed: true,
    findings,
    ruleResults,
    ...(workflowProvenance ? { workflowProvenance } : {}),
    // `applicable` stays true on both halves: the legacy shape carries no per-pillar applicability
    // flag, and every consumer reads `applicable && score !== null`, so a withheld score already
    // renders as "Not assessed" and drops out of the denominator on the strength of the null alone.
    pillars: sixPillar ?? [
      { name: 'Patterns', weight: 50, score: patternScore, applicable: true, complete: true },
      {
        name: 'Instructions',
        weight: 50,
        score: instructionScore,
        applicable: true,
        // Stage C reports this when it was handed no instructions to grade, and its score is then a
        // floor rather than a judgement. Saying so stops a 0 reading as "the instructions are bad".
        complete: !issues.some(
          (issue) =>
            typeof issue === 'object' &&
            issue !== null &&
            (issue as Record<string, unknown>).id === 'missing-instruction-input',
        ),
      },
    ],
    scoreBasis: {
      label: sixPillar
        ? 'Standard review: the six-pillar agent rubric'
        : 'Standard review: 50% patterns, 50% instruction compliance (legacy review)',
    },
    components: [
      ...parseComponents(stageA.childAgents, 'connected-agent'),
      ...parseComponents(stageA.toolDetails ?? stageA.tools, 'tool', 'toolType'),
      ...parseComponents(stageA.knowledgeDetails ?? stageA.knowledgeSources, 'knowledge', 'sourceType'),
      ...parseComponents(stageA.topics, 'topic'),
      ...parseComponents(stageA.testCaseDetails, 'test-case', 'source'),
    ],
    // A child agent is a component of the parent here, not an agent of its own, so it is inventoried
    // above but never listed as a connected agent — that list drives a fan-out to other bot records,
    // and a classic child agent has none to fan out to.
    connectedAgents: [],
    counts: instructionResults === undefined
      ? {
          passed,
          warnings:
            failedPatternRows.filter(pattern => toSeverity(pattern.Severity) === 'warning').length
            + complianceFindings.filter(finding => finding.severity === 'warning').length,
          errors:
            failedPatternRows.filter(pattern => toSeverity(pattern.Severity) === 'error').length
            + complianceFindings.filter(finding => finding.severity === 'error').length,
          // Each legacy issue is a failed criterion, so passed + failures = evaluated holds.
          evaluated: patterns.length + issues.length,
        }
      : {
          passed: ruleResults.filter(result => result.status === 'passed').length,
          warnings: ruleResults.filter(result => result.status === 'warning').length,
          errors: ruleResults.filter(result => result.status === 'error').length,
          evaluated: ruleResults.filter(result =>
            result.status === 'passed' || result.status === 'warning' || result.status === 'error').length,
        },
  };
}

/**
 * The uploaded-artifact review stored against a skill assessment.
 *
 * A skill snapshot writes ART's `ArtifactReviewResult` into the same `cat_reviewresultjson` column
 * an agent review uses, so the shape has to be recognised rather than assumed: an artifact payload
 * carries `artifactName` and `dimensions`, where an agent payload carries `agentsExperience` or the
 * three standard stages. Returning `undefined` for anything else keeps a malformed row from
 * rendering as an empty skill report, which would claim a review ran and found nothing.
 */
export function parseSkillReview(json: string | undefined): ArtifactReviewResult | undefined {
  if (!json) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = payload as Partial<ArtifactReviewResult>;
  if (typeof candidate.artifactName !== 'string' || !Array.isArray(candidate.dimensions)) return undefined;
  return candidate as ArtifactReviewResult;
}

/**
 * Turns a stored review row plus its JSON into the flattened shape the UI uses.
 *
 * A row whose JSON is missing or unparseable still yields a review — the score
 * and date on the row itself are trustworthy, and reporting `parsed: false`
 * lets the UI say so rather than showing an agent as having no components.
 */
export function parseArtReview(row: ReviewIndexRow, json: string | undefined): ArtReview {
  const base: ArtReview = {
    reviewId: row.cat_agentreviewsid ?? '',
    botId: row.cat_botid ?? '',
    botName: row.cat_botname ?? 'Agent',
    score: numOrNull(row.cat_overallscore),
    reviewDate: row.cat_reviewdate ?? '',
    sourceEnvironment: row.cat_sourceenvironment,
    pillars: [],
    findings: [],
    ruleResults: [],
    components: [],
    connectedAgents: [],
    coverage: [],
    coverageBasis: 'inferred',
    coverageSets: [],
    // An unreadable payload leaves the score on the row trustworthy but its provenance unknowable.
    scoreBasis: { label: 'Score basis unknown. Review details could not be read' },
    counts: { passed: 0, warnings: 0, errors: 0, evaluated: 0 },
    parsed: false,
  };

  if (!json) return base;

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return base;
  }

  // Set on `base` rather than only on the copilot branch: the run's duration is recorded at the top
  // of every review record, so a standard review has one too.
  if (typeof payload.durationMs === 'number') base.durationMs = payload.durationMs;

  const experience = payload.agentsExperience;
  if (typeof experience !== 'object' || experience === null) {
    // A standard (classic) review persists its three stages at the top level and has no
    // `agentsExperience` at all. Falling through to `base` reported it as an unreadable legacy row —
    // score only, no findings, no components — for a review that had just run successfully.
    if (payload.patternEvaluation || payload.instructionEvaluation || payload.stageA) {
      return parseStandardReview(base, row, payload);
    }
    return base;
  }

  const ax = experience as Record<string, unknown>;
  const model = (ax.model ?? {}) as Record<string, unknown>;
  const score = (ax.score ?? {}) as Record<string, unknown>;
  // ART already flattens the bot's raw `configuration` into these three fields when it parses the
  // agent, so this reads its result rather than re-deriving the settings from the raw config.
  const settings = (model.agentSettings ?? {}) as Record<string, unknown>;

  const connectedAgents = parseConnectedAgents(model.connectedAgents);
  const findings = parseFindings(ax.findings);

  return {
    ...base,
    parsed: true,
    pillars: parsePillars(score.pillars),
    findings,
    ruleResults: parseRuleResults(ax.ruleResults),
    // Carried through untouched for the agent map, which reads the whole ART payload rather than
    // any digest of it. `CopilotReviewDisplayPayload` is this exact shape.
    displayPayload: experience as CopilotReviewDisplayPayload,
    connectedAgents,
    instructionCoverage: parseInstructionCoverage(ax.analysisStatus, findings),
    coverage: parseCoverage(ax.coverage),
    // Reviews written before declared coverage existed persisted no basis; those were name-matched.
    coverageBasis: str(ax.coverageBasis) === 'declared' ? 'declared' : 'inferred',
    coverageSets: parseCoverageSets(ax.coverageSets),
    orchestration: parseOrchestration(ax.crossSkillOrchestration),
    scoreBasis: parseScoreBasis(score),
    skillReviewMode: str(ax.skillReviewMode),
    modelSeries: str(settings.modelSeries),
    memoryEnabled: typeof settings.enableMemory === 'boolean' ? settings.enableMemory : undefined,
    webSearchEnabled:
      typeof settings.enableWebSearch === 'boolean' ? settings.enableWebSearch : undefined,
    components: [
      ...parseComponents(model.tools, 'tool', 'kind'),
      ...parseComponents(model.skills, 'skill'),
      ...parseComponents(model.knowledge, 'knowledge', 'sourceKind'),
      ...parseComponents(model.connectedAgents, 'connected-agent'),
      ...parseComponents(model.triggers, 'trigger', 'kind'),
      ...parseComponents(model.testCases, 'test-case'),
    ],
    counts: {
      passed: num(score.passed),
      warnings: num(score.warnings),
      errors: num(score.errors),
      evaluated: num(score.evaluated),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Newest review for a bot, or undefined when it has never been reviewed.
 *
 * Sorted client-side on `cat_reviewdate` rather than with `$orderby`, and
 * `cat_islatestversion` is deliberately ignored: on 2026-08-25 the newest row
 * for `ZAVA Visual Merchandiser` carried `cat_islatestversion: false`, so that
 * flag cannot be used to find the current result.
 *
 * The heavy result JSON is fetched only for the row that wins, because it runs
 * to ~50 KB per review.
 */
async function latestReviewForBot(botId: string): Promise<ArtReview | undefined> {
  if (!botId) return undefined;

  const rows = await list<ReviewIndexRow>(
    CURRENT_ORGANIZATION,
    'cat_agentreviewses',
    REVIEW_INDEX_COLUMNS,
    `cat_botid eq '${odataLiteral(botId)}'`,
    50,
  );

  const newest = rows
    .filter((row) => row.cat_agentreviewsid)
    .sort((a, b) => Date.parse(b.cat_reviewdate ?? '') - Date.parse(a.cat_reviewdate ?? ''))[0];

  if (!newest) return undefined;

  const detail = await list<{ cat_reviewresultjson?: string }>(
    CURRENT_ORGANIZATION,
    'cat_agentreviewses',
    'cat_agentreviewsid,cat_reviewresultjson',
    `cat_agentreviewsid eq ${newest.cat_agentreviewsid}`,
    1,
  );

  return parseArtReview(newest, detail[0]?.cat_reviewresultjson);
}

/**
 * Resolves a connected agent's schema name to a bot in the reviewed
 * environment. Returns undefined when the agent cannot be found there.
 */
async function resolveChildBot(
  environmentUrl: string,
  schemaName: string,
): Promise<BotRow | undefined> {
  const rows = await list<BotRow>(
    environmentUrl,
    'bots',
    'botid,name,schemaname',
    `schemaname eq '${odataLiteral(schemaName)}'`,
    1,
  );
  return rows[0];
}

/* -------------------------------------------------------------------------- */
/* Links                                                                       */
/* -------------------------------------------------------------------------- */

/** What a link into the Agent Review Tool needs; any part may be unresolvable. */
export interface ArtLinkContext {
  /** Environment GUID for the Power Apps player path. */
  environmentId?: string;
  /** Dataverse URL of that environment, which ART needs to recognise MDA context. */
  organizationUrl?: string;
  /** The model-driven app hosting the kit, likewise required for MDA context. */
  appId?: string;
  /** This app's own id, for a link that comes back here. */
  selfAppId?: string;
  /** The Agent Review Tool code app; absent when the tool is not installed here. */
  artAppId?: string;
}

/** The environment this app — and so the Agent Review Tool — is running in. */
async function currentEnvironmentId(): Promise<string | undefined> {
  try {
    return (await getHostContext()).app.environmentId;
  } catch {
    // The host context is unavailable outside the managed app host.
    return undefined;
  }
}

/**
 * This app's own id, so a conversation opens here rather than in the Copilot
 * Agent Kit for Admins app. The Admin app also hosts an Agent Debugger, but
 * most customers of this app will not have it installed; the analysis view is
 * compiled from that app's source and served from this one instead.
 *
 * Asked of the host rather than written down. Every solution import assigns
 * this app a fresh id, so a literal is only correct in the environment it was
 * copied from; anywhere else the link names an app that is not there and the
 * player answers "no app exists".
 */
async function currentAppId(): Promise<string | undefined> {
  // The Agent Debugger is not part of the managed app, so links into it are withheld.
  return undefined;
}

/**
 * Dataverse URL of the current environment.
 *
 * `organizations.name` holds the unique name ("copilotstudiokit-dev"), which is
 * the first label of the host name in the matching URL from `GetOrganizations`.
 * Matching that way avoids assuming a domain suffix, which varies by region
 * (`crm.dynamics.com`, `crm4.dynamics.com`, `crm.dynamics.cn`).
 */
async function currentOrganizationUrl(): Promise<string | undefined> {
  try {
    const [row] = await list<{ name?: string }>(
      CURRENT_ORGANIZATION,
      'organizations',
      'organizationid,name',
      undefined,
      1,
    );

    const uniqueName = row?.name?.toLowerCase();
    if (!uniqueName) return undefined;

    const result = await MicrosoftDataverseService.GetOrganizations();
    if (!result.success) return undefined;

    return valuesOf<{ Url?: string }>(result)
      .map((organization) => organization.Url)
      .find((url) => {
        if (!url) return false;
        try {
          return new URL(url).hostname.split('.')[0]?.toLowerCase() === uniqueName;
        } catch {
          return false;
        }
      });
  } catch {
    return undefined;
  }
}

/** The model-driven app that hosts the Agent Review Tool, by unique name. */
async function kitAppId(): Promise<string | undefined> {
  try {
    const [row] = await list<{ appmoduleid?: string }>(
      CURRENT_ORGANIZATION,
      'appmodules',
      'appmoduleid,uniquename',
      `uniquename eq '${KIT_APP_UNIQUE_NAME}'`,
      1,
    );
    return row?.appmoduleid;
  } catch {
    return undefined;
  }
}

/**
 * The code app that hosts the Agent Review Tool, by logical name.
 *
 * Undefined when the tool is not installed in this environment, which is the
 * ordinary case for a customer who has this app and nothing else.
 */
async function artAppId(): Promise<string | undefined> {
  try {
    const [row] = await list<{ canvasappid?: string }>(
      CURRENT_ORGANIZATION,
      'canvasapps',
      'canvasappid,name',
      `name eq '${ART_APP_LOGICAL_NAME}'`,
      1,
    );
    return row?.canvasappid;
  } catch {
    return undefined;
  }
}

function buildPlayUrl(
  context: ArtLinkContext,
  deeplink: string,
  appId: string | undefined,
  withMdaContext = true,
): string | undefined {
  // Every part of a play URL is resolved from the environment this app is running in, so any part
  // can be missing — the destination is not installed, or the host did not answer. A URL built
  // around a blank names an app that does not exist, which looks live and lands on an error, so it
  // is worse than no link: callers suppress the link when this returns undefined.
  if (!appId || !context.environmentId) return undefined;

  const query = new URLSearchParams({ deeplink });

  // Both, or neither: ART checks for both before honouring the deeplink. Only ART checks - a link into
  // this app is read straight from the SDK's query parameters, so these would be two parameters of
  // noise naming a third app that has nothing to do with the destination.
  if (withMdaContext && context.organizationUrl && context.appId) {
    query.set('mda_org_url', context.organizationUrl);
    query.set('mda_app_id', context.appId);
  }

  return (
    `https://apps.powerapps.com/play/e/${encodeURIComponent(context.environmentId)}` +
    `/app/${encodeURIComponent(appId)}?${query.toString()}`
  );
}

/**
 * The conversation a transcript row belongs to.
 *
 * Transcript names are `<conversationId>_<botId>`, and a connected agent's rows for the same
 * conversation carry a further segment, so one conversation is recorded under several names, one per
 * agent that took part. The analyzer follows connected agents and reports an error under the name of
 * whichever transcript actually recorded it, which for a handed-off failure is the child's.
 *
 * The Agent Debugger finds a conversation by name AND by the agent that owns it, so a child's full
 * name matches nothing when the agent under review is the parent - which is why some example links
 * opened and others did not. The leading conversation id is the part every participant shares, so that
 * is what the link carries: it selects the parent's rows, and the debugger expands the handoff into
 * the connected agent itself.
 */
export function conversationKey(transcriptName: string): string {
  const cut = transcriptName.indexOf('_');
  return cut > 0 ? transcriptName.slice(0, cut) : transcriptName;
}

export const artService = {
  /** Read only exact accepted artifacts from the frozen plan; never expand today's live graph. */
  async getSnapshotReview(
    snapshotId: string, botId: string, organizationUrl: string,
    assessments: import('../models/orchestration').AssessmentProgress[],
  ): Promise<AggregatedReview> {
    const context = await artService.linkContext();
    if (!context.organizationUrl || !context.environmentId) {
      throw new Error('Open the app in Power Apps so it can resolve the environment it is installed in. Snapshot evidence needs an environment ID and an organization URL.');
    }
    // A review created against this app's own environment stores the `'current'` sentinel rather than
    // a URL, so it has to be resolved before any comparison: `new URL('current')` throws, and the
    // failure surfaced as an unexplained "couldn't load the analysis" for every such snapshot.
    //
    // A reviewed agent may live in another environment, and that is the normal case rather than the
    // exception: `ConnectorTransport` reads `bots` and `botcomponents` from wherever the agent was
    // authored while every row the pipeline writes - including the `cat_agentreviews` rows read
    // below - lands in this one. Refusing a foreign origin here therefore rejected precisely the
    // reviews the transport exists to produce, and did it after the work was already paid for, so a
    // finished snapshot reported "we couldn't load the analysis" with its evidence sitting in the
    // table. Identity is still enforced, but by the check that matches the split: every row's
    // `cat_sourceenvironment` must name the reviewed environment, which is what the engine stamped
    // on it from `capture.organization`.
    const reviewedUrl = resolveOrganizationUrl(organizationUrl, context.organizationUrl);
    const agents: AggregatedAgent[] = [];
    /**
     * The reviewed agent leads; its connected agents follow in the order the snapshot recorded them.
     *
     * Assessments come back in whatever order orchestration wrote them, which regularly put a
     * connected agent first — so the row of agent buttons opened on a child while the parent, the
     * actual subject of the review, sat at the end.
     *
     * Compared case-insensitively, as every other identity comparison here is: the assessment stores
     * a lower-cased id while `botId` is whatever the review row holds, and an exact comparison would
     * silently order by nothing at all rather than fail.
     */
    const isSubject = (agentId: string): boolean => agentId.toLowerCase() === botId.toLowerCase();
    const assessed = assessments
      .filter(item => item.stage === 'agent-review')
      .sort((a, b) => Number(isSubject(b.agentId)) - Number(isSubject(a.agentId)));
    for (const item of assessed) {
      if (item.environmentId.toLowerCase() !== context.environmentId.toLowerCase()) throw new Error('The snapshot contains an unsupported source environment.');
      // An uploaded artifact has no bot record and no source environment, so the identity checks
      // that make an agent review trustworthy cannot be applied to it. What still has to hold is
      // the snapshot link: the row must be the exact review this snapshot accepted.
      //
      // A declarative agent is the same case for the same reason — it is graded from an uploaded
      // package — but it cannot be recognised from the subject id the way a skill can, because a DA
      // subject id is a bare GUID with no prefix. It is recognised from the stored row instead, by
      // the `cat_agenttype` ART itself writes. That is why the bot-id filter is no longer part of
      // the query: the row has to be read before its kind is known. Nothing is weakened by the
      // move, because `cat_agentreviewsid` is the primary key, so the filter never narrowed
      // anything, and the agent branch below still checks `cat_botid` on the row it got back.
      const isSkill = item.agentId.startsWith(SKILL_SUBJECT_PREFIX);
      let review: ArtReview | undefined;
      let artifactReview: ArtifactReviewResult | undefined;
      let declarativeAgentReview: DeclarativeAgentReview | undefined;
      if (item.status === 'succeeded' && item.resultId) {
        const rows = await list<ReviewIndexRow & { cat_reviewresultjson?: string; _cat_resultid_value?: string; cat_sourceenvironment?: string; cat_agenttype?: number | string }>(
          CURRENT_ORGANIZATION, 'cat_agentreviewses',
          `${REVIEW_INDEX_COLUMNS},cat_reviewresultjson,_cat_resultid_value,cat_agenttype`,
          `cat_agentreviewsid eq ${item.resultId} and _cat_resultid_value eq ${snapshotId}`, 2,
        );
        const linked = rows.length === 1 &&
          rows[0].cat_agentreviewsid?.toLowerCase() === item.resultId.toLowerCase() &&
          rows[0]._cat_resultid_value?.toLowerCase() === snapshotId.toLowerCase();
        const isDeclarativeAgent = linked && Number(rows[0].cat_agenttype) === AGENT_TYPE.M365_DECLARATIVE_AGENT;
        if (isSkill) {
          artifactReview = linked ? parseSkillReview(rows[0].cat_reviewresultjson) : undefined;
          if (!artifactReview) throw new Error(`The accepted review for ${item.agentName} is unavailable or does not match this snapshot.`);
        } else if (isDeclarativeAgent) {
          // The score is read from the column rather than recomputed: ART's DA rubric weighs six
          // criteria and drops the weight of any it could not assess, and reproducing that here
          // would be a second implementation of the thing this app exists not to duplicate.
          declarativeAgentReview = {
            score: numOrNull(rows[0].cat_overallscore),
            data: parseDAReviewResult(rows[0].cat_reviewresultjson),
          };
        } else {
          if (!linked || rows[0].cat_botid?.toLowerCase() !== item.agentId.toLowerCase() || !rows[0].cat_sourceenvironment ||
            new URL(rows[0].cat_sourceenvironment).origin !== new URL(reviewedUrl).origin) {
            throw new Error(`The accepted review for ${item.agentName} is unavailable or does not match this snapshot.`);
          }
          review = parseArtReview(rows[0], rows[0].cat_reviewresultjson);
        }
      }
      agents.push({
        botId: item.agentId, botName: item.agentName, isRoot: isSubject(item.agentId),
        review, artifactReview, declarativeAgentReview,
        unresolvedReason: review || artifactReview || declarativeAgentReview ? undefined : item.error ?? `Snapshot assessment: ${item.status}`,
      });
    }
    // The mean of the agents actually reviewed, the same rule standalone reviews use and the same
    // number the engine stores on the snapshot row. An agent that could not be reviewed is excluded
    // rather than counted as zero: unknown is not the same as bad.
    return { agents, rolledUpScore: aggregateScore(agents), reviewedCount: agents.filter(isReviewed).length, totalCount: agents.length };
  },
  /**
   * The reviewed agent plus every agent it connects to.
   *
   * ART scores connected agents only as *patterns of the parent* — it extracts
   * their name and description and never opens their own components (verified
   * in `StageAService`, where an `AgentDialog` component is recorded and then
   * skipped). So a per-child score has to come from that child's own ART
   * review, and the rolled-up number is a mean across whichever agents have
   * one. Agents nobody has reviewed are reported, not counted.
   */
  async getAggregatedReview(botId: string, environmentUrl?: string): Promise<AggregatedReview> {
    const root = await latestReviewForBot(botId);

    const agents: AggregatedAgent[] = [
      {
        botId,
        botName: root?.botName ?? 'Agent',
        isRoot: true,
        review: root,
      },
    ];

    for (const child of root?.connectedAgents ?? []) {
      if (!child.botSchemaName || !environmentUrl) {
        agents.push({
          botName: child.name,
          isRoot: false,
          unresolvedReason: 'This agent could not be located in the reviewed environment.',
        });
        continue;
      }

      try {
        const bot = await resolveChildBot(environmentUrl, child.botSchemaName);
        if (!bot?.botid) {
          agents.push({
            botName: child.name,
            isRoot: false,
            unresolvedReason: 'Not found in the reviewed environment.',
          });
          continue;
        }

        agents.push({
          botId: bot.botid,
          botName: bot.name ?? child.name,
          isRoot: false,
          review: await latestReviewForBot(bot.botid),
        });
      } catch {
        // One unreachable child must not fail the whole screen.
        agents.push({
          botName: child.name,
          isRoot: false,
          unresolvedReason: 'That environment could not be reached.',
        });
      }
    }

    const reviewedCount = agents.filter((agent) => agent.review).length;

    return {
      agents,
      rolledUpScore: aggregateScore(agents),
      reviewedCount,
      totalCount: agents.length,
    };
  },

  /**
   * The Agent Review Tool's own landing page, for when the destination is "go
   * and review something" rather than a particular saved report.
   *
   * Undefined when the tool is not installed in this environment, so the caller
   * can name it in prose instead of linking somewhere that does not exist.
   */
  appUrl(context: ArtLinkContext): string | undefined {
    return buildPlayUrl(context, '/agent-review-tool', context.artAppId);
  },

  /**
   * Opens one conversation in the Agent Debugger, in this app.
   *
   * The analysis view is the Agent Debugger's own, compiled from the Admin
   * app's source, so the link needs what that view needs: the conversation to
   * read, the environment holding it, and the agent whose transcripts to search.
   * All three are required — without them the page can only report an
   * incomplete link — so this returns `undefined` rather than producing a link
   * that lands on an error.
   *
   * `agentId` is the bot id. Handing the view a bot id is what lets it skip the
   * debugger's `cat_agentdetailses` lookup, so a conversation opens even for an
   * agent that was never registered in the Copilot Studio Kit.
   *
   * `environmentId` and `agentName` are passed when known. Neither is needed to
   * find the conversation; they only spare the view a lookup and let it name
   * the agent in its header before the transcript has loaded.
   */
  debuggerUrl(input: {
    conversationId: string;
    agentId: string | undefined;
    agentName?: string;
    environmentUrl: string | undefined;
    context: ArtLinkContext;
  }): string | undefined {
    const environmentUrl = input.environmentUrl || input.context.organizationUrl;
    if (!input.conversationId || !input.agentId || !environmentUrl) return undefined;

    const route = new URLSearchParams({
      conversationId: conversationKey(input.conversationId),
      environmentUrl,
      agentId: input.agentId,
    });
    if (input.context.environmentId) route.set('environmentId', input.context.environmentId);
    if (input.agentName) route.set('agentName', input.agentName);

    return buildPlayUrl(input.context, `/agent-debugger?${route.toString()}`, input.context.selfAppId, false);
  },

  /**
   * Everything needed to build a link into the Agent Review Tool.
   *
   * `organizationUrl` is resolved by matching the current organization's unique
   * name against the host names returned by `GetOrganizations`. The Power Apps
   * SDK context carries an environment GUID but no Dataverse URL, and the
   * `organization` table has no URL column, so the two have to be joined. The
   * unique name is used rather than the friendly name because friendly names
   * are not unique and can be renamed.
   */
  async linkContext(): Promise<ArtLinkContext> {
    const [environmentId, organizationUrl, appId, selfAppId, resolvedArtAppId] = await Promise.all([
      currentEnvironmentId(),
      currentOrganizationUrl(),
      kitAppId(),
      currentAppId(),
      artAppId(),
    ]);

    return { environmentId, organizationUrl, appId, selfAppId, artAppId: resolvedArtAppId };
  },
};
