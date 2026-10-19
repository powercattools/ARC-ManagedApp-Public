import {
  AGENT_PILLAR_WEIGHTS,
  SKILL_DIMENSION_WEIGHTS,
  STANDARD_WORKFLOW_RULES,
  ruleById,
  type AgentPillar,
  type Harness,
  type Rule,
  type RubricDimensionId,
  type RuleId,
  type Severity,
} from './art-ports';
import { VALIDATION_RULES } from '../validation/ai-nodes/catalog';
import {
  VALIDATION_CATALOG_VERSION,
  type NodeKind,
  type RuleContract,
} from '../validation/ai-nodes/contracts';
export { canonicalJson as canonicalAiValue } from '../ai-workflow/provenance';

export const AI_REVIEW_POLICY_VERSION = 'arc2-unified-v3' as const;
export type AiReviewHarness = 'standard' | 'copilot' | 'skill';
/** The pillar vocabulary is `review-core`'s; these names are kept so call sites read in context. */
export type AiReviewPillar = AgentPillar;
export type AiReviewDimension = RubricDimensionId;
export type AiReviewGroup = AiReviewPillar | AiReviewDimension;
export type AiReviewSeverity = Severity;

export const AI_AGENT_WEIGHTS: Readonly<Record<AiReviewPillar, number>> = AGENT_PILLAR_WEIGHTS;
export const AI_ARTIFACT_WEIGHTS: Readonly<Record<AiReviewDimension, number>> = SKILL_DIMENSION_WEIGHTS;

/**
 * Everything that differs between harnesses lives here, so the scorer itself contains no harness
 * names and runs one identical code path for all three. Extending the engine means editing this
 * table, not the arithmetic.
 *
 * - `weights` always total 100. Both agent harnesses declare the same table, so a Standard and a
 *   Copilot agent are reported on one denominator and neither is advantaged by its profile. The
 *   scorer still renormalizes, but only when an agent genuinely has none of a group's subject
 *   matter, which is a property of that agent rather than of its harness.
 * - `labels` rename a group the harness fills differently. Standard has no inline skills, so its
 *   Skills pillar carries the topic rules and is reported as Topics; the question each pillar
 *   answers is the same, so its weight is the same.
 * - `disclosures` are non-gating notes the harness always reports.
 */
export const HARNESS_POLICY: Readonly<Record<AiReviewHarness, Readonly<{
  profile: 'agent-pillars' | 'artifact-dimensions';
  reference: string;
  weights: Readonly<Partial<Record<AiReviewGroup, number>>>;
  labels: Readonly<Partial<Record<AiReviewGroup, string>>>;
  disclosures: readonly string[];
}>>> = Object.freeze({
  standard: Object.freeze({
    profile: 'agent-pillars',
    reference: 'specs/022-unified-ai-review/contracts.md#six-pillar-score',
    weights: AI_AGENT_WEIGHTS,
    labels: Object.freeze({ skills: 'Topics' }),
    disclosures: Object.freeze([] as string[]),
  }),
  copilot: Object.freeze({
    profile: 'agent-pillars',
    reference: 'specs/022-unified-ai-review/contracts.md#six-pillar-score',
    weights: AI_AGENT_WEIGHTS,
    labels: Object.freeze({}),
    disclosures: Object.freeze([] as string[]),
  }),
  skill: Object.freeze({
    profile: 'artifact-dimensions',
    reference: 'specs/022-unified-ai-review/harness-migration.md#standalone-scoring-profile',
    weights: AI_ARTIFACT_WEIGHTS,
    labels: Object.freeze({}),
    disclosures: Object.freeze([] as string[]),
  }),
});

/**
 * The 46 claims this catalog routes to the AI nodes.
 *
 * This list is the catalog's *membership* and nothing more. Severity, pillar, dimension and tags
 * used to be restated here, which meant every rule's scoring policy existed twice and could drift
 * apart silently. They are now read from `review-core`'s registry while the catalog is built, so a
 * rule declares its policy exactly once — in the `review-core/rules/*.rules.ts` file defining it.
 *
 * The ids stay a literal tuple because two things depend on them: `AiReviewRuleId`, which call
 * sites use to name a claim, and the membership tripwire in `buildCatalog`, which fails if the node
 * catalog and this list stop naming the same set.
 */
const AI_RULE_IDS = [
  'STD-PATTERN-MODEL-NAME',
  'STD-PATTERN-MODEL-DESCRIPTION',
  'STD-PATTERN-INPUT-NAME',
  'STD-PATTERN-INPUT-DESCRIPTION',
  'STD-PATTERN-OUTPUT-NAME',
  'STD-PATTERN-OUTPUT-DESCRIPTION',
  'STD-ROUTE-TOPIC-OVERLAP',
  'STD-PATTERN-MISSING-TRIGGERS',
  'STD-TOL-ROUTING-DESCRIPTION',
  'STD-CON-DELEGATION-DESCRIPTION',
  'scope-definition',
  'out-of-scope-handling',
  'persona-and-tone',
  'privacy-and-sensitive-data',
  'fallback-when-uncertain',
  'citations-and-sources',
  'formatting-guidelines',
  'clarifying-questions',
  'prompt-injection-resilience',
  'link-safety',
  'advice-disclaimers',
  'accuracy-quality',
  'tool-routing-hints',
  'escalation-guidance',
  'deterministic-language',
  'INS-02',
  'INS-03',
  'INS-04',
  'INS-05',
  'INS-06',
  'INS-07',
  'XSK-01',
  'XSK-02',
  'XSK-03',
  'XSK-04',
  'XSK-05',
  'XSK-06',
  'SKL-09',
  'SKL-10',
  'SKL-AI-CLARITY',
  'SKL-AI-ACTIONABILITY',
  'SKL-AI-SCOPE',
  'SKL-AI-COMPOSABILITY',
  'SKL-AI-RESOURCE-ALIGNMENT',
  'SKL-AI-PREREQUISITES',
  'SKL-AI-OPERATIONAL-GUARDRAILS',
] as const;

export type AiReviewRuleId = (typeof AI_RULE_IDS)[number];

const AI_RULE_ID_SET: ReadonlySet<string> = new Set(AI_RULE_IDS);

/**
 * `review-core` names the two skill harnesses separately — a skill inside a copilot agent
 * (`copilot-skill`) and a standalone upload (`standalone-skill`) — while this catalog has always
 * used the coarser `copilot` / `skill` pair. This is the bridge between the two vocabularies, and
 * the only place they meet.
 */
const REGISTRY_HARNESSES: Readonly<Record<AiReviewHarness, readonly Harness[]>> = Object.freeze({
  standard: ['standard'],
  copilot: ['copilot', 'copilot-skill'],
  skill: ['standalone-skill'],
});

/**
 * SKL-09 is the one claim whose registry entry cannot answer for the artifact profile yet: it is
 * still registered as a copilot-only agent rule declaring `pillar: 'skills'`, so there is no
 * standalone-skill dimension to read. Moving it is a separate change that moves live skill scores,
 * so until that lands its dimension stays pinned here and this refactor moves nothing on its own.
 *
 * `registry-catalog-parity.test.ts` carries the matching `KNOWN_PILLAR_DRIFT` entry. Delete both
 * together when SKL-09 moves harness.
 */
const PENDING_SKILL_DIMENSION: Readonly<Partial<Record<AiReviewRuleId, AiReviewDimension>>> =
  Object.freeze({ 'SKL-09': 'instruction-quality' });

function registeredRule(id: AiReviewRuleId): Rule<never> {
  const rule = ruleById(id as RuleId);
  if (!rule) throw new Error(`${id} is routed to an AI node but is not registered in review-core.`);
  return rule;
}

/** An AI claim is always scored, so a severity carrying no weight cannot be one. */
function registeredSeverity(id: AiReviewRuleId, rule: Rule<never>): 'high' | 'medium' {
  if (rule.severity !== 'high' && rule.severity !== 'medium') {
    throw new Error(`${id} is scored by an AI node, so its severity cannot be '${rule.severity}'.`);
  }
  return rule.severity;
}

/** The group a rule scores in for one harness, or undefined when it claims no group there. */
function registeredGroup(rule: Rule<never>, harness: AiReviewHarness): AiReviewGroup | undefined {
  const declared = rule.pillar;
  // A rule scoring in the same group everywhere declares one pillar rather than a per-harness map.
  // Only an agent pillar can be spelled that way, so it never answers for the artifact profile.
  if (typeof declared === 'string') return harness === 'skill' ? undefined : declared as AiReviewGroup;
  for (const name of REGISTRY_HARNESSES[harness]) {
    const group = declared[name];
    if (group) return group as AiReviewGroup;
  }
  return undefined;
}

export interface AiRuleDefinition {
  readonly id: AiReviewRuleId;
  readonly catalogVersion: typeof VALIDATION_CATALOG_VERSION;
  readonly kind: 'check';
  readonly execution: 'ai';
  readonly subjectScope: 'agent' | 'skill' | 'skill-set';
  readonly nodes: readonly NodeKind[];
  readonly harnesses: readonly AiReviewHarness[];
  readonly contract: Readonly<RuleContract>;
  readonly severity: 'high' | 'medium';
  readonly catalogWeight: 1 | 0.5;
  readonly scoringOwners: Readonly<Partial<Record<AiReviewHarness, AiReviewGroup>>>;
  readonly tags: readonly string[];
  readonly evidenceFieldPaths: readonly string[];
  readonly evidencePolicy: string;
  readonly sourceDefinition: string;
  readonly policyReference: string;
  readonly historicalIds: readonly string[];
  readonly separatelyOwnedClaims: readonly string[];
}

const separateClaims: Readonly<Partial<Record<AiReviewRuleId, readonly string[]>>> = {
  'SKL-AI-CLARITY': ['deterministic-missing-field', 'deterministic-format'],
  'SKL-AI-ACTIONABILITY': ['SKL-09', 'SKL-AI-PREREQUISITES'],
  'SKL-AI-COMPOSABILITY': ['XSK-05'],
  'SKL-AI-RESOURCE-ALIGNMENT': ['SKL-10', 'deterministic-orphan-file'],
  'SKL-AI-PREREQUISITES': ['SKL-09'],
  'SKL-AI-OPERATIONAL-GUARDRAILS': ['SCR-*', 'HTML-*', 'MD-*', 'PKG-*'],
};

function evidencePaths(id: AiReviewRuleId, nodes: readonly NodeKind[]): readonly string[] {
  if (nodes.includes('standard')) {
    const historicalId = id === 'STD-TOL-ROUTING-DESCRIPTION' || id === 'STD-CON-DELEGATION-DESCRIPTION'
      ? 'STD-PATTERN-TOOL-ROUTING-GAP' : id;
    const template = STANDARD_WORKFLOW_RULES.find(item => item.ruleId === historicalId);
    if (!template) throw new Error(`No pinned Standard evidence policy for ${id}.`);
    return [...template.allowedFieldPaths];
  }
  if (nodes.includes('copilot-instructions')) {
    return id === 'INS-07' ? ['agent_instructions', 'configuredCapabilities'] : ['agent_instructions'];
  }
  if (id === 'SKL-AI-CLARITY') return ['skill_markdown'];
  const paths = ['skill_markdown', 'resource_manifest', 'resources[<captured-path>].content'];
  if (nodes.includes('cross-skill')) paths.unshift('skill_inventory');
  if (id === 'SKL-09' || id === 'XSK-04') paths.push('configuredCapabilities');
  if (id === 'XSK-04') paths.push('agent_instructions');
  return paths;
}

function buildCatalog(): readonly AiRuleDefinition[] {
  const seen = new Set<string>();
  const catalog = VALIDATION_RULES.map((definition): AiRuleDefinition => {
    if (!AI_RULE_ID_SET.has(definition.id) || seen.has(definition.id)) {
      throw new Error(`Missing or duplicate native AI scoring metadata: ${definition.id}.`);
    }
    seen.add(definition.id);
    const id = definition.id as AiReviewRuleId;
    const rule = registeredRule(id);
    const severity = registeredSeverity(id, rule);
    const standalone = definition.nodes.includes('standalone-skill');
    const harnesses: AiReviewHarness[] = definition.nodes.includes('standard') ? ['standard']
      : standalone ? ['copilot', 'skill'] : ['copilot'];
    const owners: Partial<Record<AiReviewHarness, AiReviewGroup>> = {};
    for (const harness of harnesses) {
      const group = harness === 'skill'
        ? (registeredGroup(rule, 'skill') ?? PENDING_SKILL_DIMENSION[id])
        : registeredGroup(rule, harness);
      if (!group) throw new Error(`Missing ${harness === 'skill' ? 'artifact' : harness} scoring owner for ${id}.`);
      const profile = harness === 'skill' ? AI_ARTIFACT_WEIGHTS : AI_AGENT_WEIGHTS;
      if (!Object.hasOwn(profile, group) || group === 'evaluation') {
        throw new Error(`${id} scores in '${group}', which the ${harness} profile does not weigh.`);
      }
      owners[harness] = group;
    }
    const contract = structuredClone(definition.contract);
    Object.freeze(contract.passWhen);
    Object.freeze(contract.failWhen);
    Object.freeze(contract.notApplicableWhen);
    return Object.freeze({
      id, catalogVersion: VALIDATION_CATALOG_VERSION, kind: 'check',
      execution: definition.execution,
      subjectScope: standalone ? 'skill' : definition.nodes.includes('cross-skill') ? 'skill-set' : 'agent',
      nodes: Object.freeze([...definition.nodes]), harnesses: Object.freeze(harnesses),
      contract: Object.freeze(contract), severity,
      catalogWeight: severity === 'high' ? 1 : 0.5,
      scoringOwners: Object.freeze(owners), tags: Object.freeze([...rule.tags]),
      evidenceFieldPaths: Object.freeze([...evidencePaths(id, definition.nodes)]),
      evidencePolicy: 'Only the frozen expected key authorizes exact readable field quotes or explicitly permitted complete-field absence evidence. Complete-exception Pass requires the strict normalizer completion reference.',
      sourceDefinition: definition.sourceDefinition,
      policyReference: `specs/022-unified-ai-review/rule-map.md#${id}`,
      historicalIds: Object.freeze(id === 'STD-TOL-ROUTING-DESCRIPTION' || id === 'STD-CON-DELEGATION-DESCRIPTION'
        ? ['STD-PATTERN-TOOL-ROUTING-GAP'] : []),
      separatelyOwnedClaims: Object.freeze([...(separateClaims[id] ?? [])]),
    });
  });
  if (seen.size !== AI_RULE_IDS.length) throw new Error('The pinned AI catalog and scoring map differ.');
  return Object.freeze(catalog);
}

export const AI_RULE_CATALOG = buildCatalog();

/** Resolve an exact registered claim; prefixes and historical summary IDs never select an owner. */
export function getAiRuleDefinition(ruleId: string, harness?: AiReviewHarness): AiRuleDefinition {
  const definition = AI_RULE_CATALOG.find(item => item.id === ruleId);
  if (!definition || (harness && !definition.harnesses.includes(harness))) {
    throw new Error(`No native AI scoring definition for ${harness ?? 'any harness'}/${ruleId}.`);
  }
  return definition;
}

/** Collision-free identity from captured IDs, never a display name, array index or finding count. */
export function aiScoreOwnerKey(harness: AiReviewHarness, ruleId: string, subjectId: string): string {
  if (![ruleId, subjectId].every(value => value.trim())) throw new Error('Rule and subject identities must be nonempty.');
  return JSON.stringify([AI_REVIEW_POLICY_VERSION, harness, ruleId, subjectId]);
}
