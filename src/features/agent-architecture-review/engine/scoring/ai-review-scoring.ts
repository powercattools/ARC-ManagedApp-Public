import {
  AI_REVIEW_POLICY_VERSION, AI_RULE_CATALOG, HARNESS_POLICY, aiScoreOwnerKey, canonicalAiValue,
  type AiReviewGroup, type AiReviewHarness,
} from './ai-review-catalog';
import { mergeAiWorkflowReview } from './ai-review-merge';
import { aiRuleResults, aiRuleStatus } from './ai-rule-results';
import { validateFrozenAiWorkflowSnapshot } from './ai-review-source';
import { ruleById, ruleResultCredit, scoreLegacyDeterministicRules, UNCONDITIONAL_AGENT_PILLARS, type RuleId } from './art-ports';
import type {
  AiEvaluationSignals, AiReviewAssessment, AiReviewCoverage, AiWorkflowReviewSnapshot, MergedAiReview,
} from './ai-review-contracts';
export type { AiEvaluationSignals } from './ai-review-contracts';

export interface AiScoringPolicy {
  version: string;
  reference: string;
  weights: Readonly<Partial<Record<AiReviewGroup, number>>>;
}

export interface AiScoringOptions {
  evaluation?: AiEvaluationSignals;
  /** A persisted policy must carry every approved weight; absent entries have no equal-weight fallback. */
  policy?: AiScoringPolicy;
  /** Host-proven scope, not inference from an empty result array or a model's prose. */
  excludedGroups?: Readonly<Partial<Record<AiReviewGroup, { reason: string }>>>;
}

export interface AiScoreContribution {
  assessmentKey: string;
  scoreOwnerKey: string;
  ruleId: string;
  subjectId: string;
  scoringGroup: AiReviewGroup | null;
  status: 'scored' | 'pending' | 'excluded' | 'informational';
  scoreEffect: 'rule-weighted' | 'evaluation-evidence' | 'unresolved-policy' | 'none';
  catalogWeight: number;
  earnedWeight: number;
  possibleWeight: number;
  pendingWeight: number;
  reason: string;
}

export interface AiGroupScore {
  id: AiReviewGroup;
  label: string;
  nominalWeight: number | null;
  effectiveWeight: number | null;
  /** `excluded` means the host proved the group has no applicable subject matter; it is not a missing provider. */
  status: 'scored' | 'provisional' | 'excluded' | 'unavailable';
  value: number | null;
  unroundedValue: number | null;
  earnedWeight: number;
  possibleWeight: number;
  pendingWeight: number;
  coverage: AiReviewCoverage;
  reason: string;
}

export interface AiReviewScore {
  policyVersion: typeof AI_REVIEW_POLICY_VERSION;
  profile: 'agent-pillars' | 'artifact-dimensions';
  contributions: readonly AiScoreContribution[];
  groups: readonly AiGroupScore[];
  coverage: MergedAiReview['coverage'];
  overall: {
    status: 'complete' | 'provisional' | 'unavailable';
    /** Only a complete composite occupies value; consumers cannot accidentally label a partial 100 as complete. */
    value: number | null;
    unroundedValue: number | null;
    provisionalValue: number | null;
    provisionalUnroundedValue: number | null;
    reasons: readonly string[];
  };
}

const groupLabels: Readonly<Record<AiReviewGroup, string>> = {
  instructions: 'Instructions', skills: 'Skills', tools: 'Tools', knowledge: 'Knowledge',
  orchestration: 'Orchestration', evaluation: 'Evaluation',
  'trigger-clarity': 'Trigger clarity', 'task-focus': 'Task focus', 'instruction-quality': 'Instruction quality',
  portability: 'Portability', 'safety-evidence': 'Safety and evidence discipline', 'packaging-quality': 'Packaging quality',
};

/** The spec, not result contents, selects the profile and its nominal weights. */
export function defaultAiScoringPolicy(harness: AiReviewHarness): AiScoringPolicy {
  return {
    version: AI_REVIEW_POLICY_VERSION,
    reference: HARNESS_POLICY[harness].reference,
    weights: { ...HARNESS_POLICY[harness].weights },
  };
}

/**
 * One row's part in its group, expressed in the credit units the scorer actually divides.
 *
 * `catalogWeight` keeps its own meaning — it is the catalog's severity claim, and the tamper guard
 * below re-derives it from the rule's severity — but it is no longer what the arithmetic divides.
 * Severity now does the job it does everywhere else in the system: it sets how much credit a
 * *failure* forfeits, rather than how much the rule counts for. So every eligible row is worth one,
 * a `medium` failure keeps half of it, and a `high` failure keeps none. Disclosing those same units
 * is what keeps the lab panel honest: `100 * earned / possible` still reproduces the group value,
 * which it would not if the row showed severity weights beside a credit-derived score.
 */
function contribution(assessment: AiReviewAssessment): AiScoreContribution {
  const excluded = assessment.applicability.state === 'not-applicable';
  const scored = !excluded && (assessment.outcome === 'pass' || assessment.outcome === 'fail');
  const legacyStatus = aiRuleStatus(assessment);
  const credit = ruleResultCredit(legacyStatus);
  return {
    assessmentKey: assessment.assessmentKey, scoreOwnerKey: assessment.scoreOwnerKey,
    ruleId: assessment.ruleId, subjectId: assessment.subjectId,
    scoringGroup: assessment.scoringGroup,
    status: excluded ? 'excluded' : scored ? 'scored' : 'pending',
    scoreEffect: assessment.ruleId === 'local-pattern-8' ? 'unresolved-policy'
      : assessment.scoringGroup === 'evaluation' ? 'evaluation-evidence' : 'rule-weighted',
    catalogWeight: assessment.catalogWeight,
    earnedWeight: credit ?? 0,
    possibleWeight: credit === null ? 0 : 1,
    // `failed` is reached only by an unanswered row that would otherwise have counted, which is
    // exactly what "pending" has to mean: an excluded or informational row is not owed an answer.
    pendingWeight: legacyStatus === 'failed' ? 1 : 0,
    reason: assessment.reason,
  };
}

/**
 * The Evaluation pillar scores from captured evidence rather than from rule outcomes, but the
 * weights it splits across are the same four EVL rules the deterministic scorer runs: a usable set
 * (the gate), capability coverage, multi-turn depth, and an expected response. Reading them from
 * the registry means that split is declared once — in `evaluation.rules.ts` — instead of being
 * restated here as four literals that can drift away from it silently.
 */
const EVALUATION_WEIGHTS = evaluationProfile();

function evaluationProfile(): Readonly<{ usableSet: number; coverage: number; multiTurn: number; expectedResponse: number }> {
  const weightOf = (id: RuleId): number => {
    const rule = ruleById(id);
    if (!rule || typeof rule.weight !== 'number') {
      throw new Error(`${id} must declare a weight to take part in the Evaluation profile.`);
    }
    return rule.weight;
  };
  const profile = {
    usableSet: weightOf('EVL-01'), coverage: weightOf('EVL-02'),
    multiTurn: weightOf('EVL-05'), expectedResponse: weightOf('EVL-04'),
  };
  const total = profile.usableSet + profile.coverage + profile.multiTurn + profile.expectedResponse;
  if (total !== 100) throw new Error(`The Evaluation profile must total 100, not ${total}.`);
  return Object.freeze(profile);
}

function evaluationScore(signals: AiEvaluationSignals | undefined): { value: number | null; complete: boolean; reason: string } {
  if (!signals || signals.availability === 'unavailable') {
    return { value: null, complete: false, reason: signals?.reason || 'Captured Evaluation evidence is unavailable.' };
  }
  if (!signals.reason.trim()) throw new Error('Evaluation evidence requires a captured-scope reason.');
  const ratio = signals.capabilityCoverageRatio;
  if (ratio !== null && (!Number.isFinite(ratio) || ratio < 0 || ratio > 1)) {
    throw new Error('Capability coverage must be an evidence-derived ratio from zero through one.');
  }
  const complete = signals.availability === 'complete';
  if (signals.hasUsableSet === false || signals.hasCases === false) {
    return { value: complete ? 0 : null, complete, reason: signals.reason };
  }
  if (signals.hasUsableSet !== true || signals.hasCases !== true || ratio === null
    || signals.hasMultiTurnCoverage === null || signals.expectedResponseRequirementSatisfied === null) {
    return { value: null, complete: false, reason: 'Evaluation signals are missing; confirmed absence and unreadable evidence are different.' };
  }
  return {
    value: EVALUATION_WEIGHTS.usableSet + EVALUATION_WEIGHTS.coverage * ratio
      + EVALUATION_WEIGHTS.multiTurn * Number(signals.hasMultiTurnCoverage)
      + EVALUATION_WEIGHTS.expectedResponse * Number(signals.expectedResponseRequirementSatisfied),
    complete, reason: signals.reason,
  };
}

function groupCoverage(assessments: readonly AiReviewAssessment[]): AiReviewCoverage {
  const eligible = assessments.filter(item => item.catalogWeight > 0);
  const excluded = eligible.filter(item => item.applicability.state === 'not-applicable').length;
  const completed = eligible.filter(item => item.applicability.state !== 'not-applicable'
    && (item.outcome === 'pass' || item.outcome === 'fail') && !item.incomplete).length;
  return {
    expected: eligible.length, completed, excluded, pending: eligible.length - excluded - completed,
    ratio: eligible.length > excluded ? completed / (eligible.length - excluded) : null,
    complete: eligible.length - excluded === completed,
  };
}

/** Whole assessments vote once; detail findings and retained provider copies never enter arithmetic. */
export function scoreAiReview(report: MergedAiReview, options: AiScoringOptions = {}): AiReviewScore {
  if (report.policyVersion !== AI_REVIEW_POLICY_VERSION) throw new Error('Unsupported native AI scoring policy.');
  if (report.coverage.workflow) {
    if (options.evaluation
      && canonicalAiValue(options.evaluation) !== canonicalAiValue(report.frozenScoring?.evaluation ?? null)) {
      throw new Error('Current Evaluation signals cannot replace the frozen workflow Evaluation evidence.');
    }
    if (options.excludedGroups && Object.keys(options.excludedGroups).length) {
      throw new Error('Workflow group exclusions require an explicit frozen native policy; current scope cannot be substituted.');
    }
    options = { ...options, evaluation: report.frozenScoring?.evaluation };
  }
  const defaultPolicy = defaultAiScoringPolicy(report.harness);
  const policy = options.policy ?? defaultPolicy;
  /** Only a blocker can withhold a composite. A note is disclosed but never silences the score. */
  const blockers: string[] = [];
  const notes: string[] = [];
  if (report.coverage.workflow && report.coverage.sourceBinding?.status !== 'frozen-host-review') {
    blockers.push('A unified workflow score requires the native ledger frozen with the saved AI request.');
  }
  if (policy.version !== defaultPolicy.version || !policy.reference.trim()) blockers.push('The scoring policy is unsupported or has no source reference.');
  const unique = new Map<string, AiReviewAssessment>();
  for (const assessment of report.assessments) {
    const expectedKey = aiScoreOwnerKey(report.harness, assessment.ruleId, assessment.subjectId);
    const definition = AI_RULE_CATALOG.find(rule => rule.id === assessment.ruleId);
    const weight = assessment.severity === 'high' ? 1 : assessment.severity === 'medium' ? 0.5 : 0;
    if (assessment.scoreOwnerKey !== expectedKey || assessment.catalogWeight !== weight
      || (definition && (definition.severity !== assessment.severity
        || definition.scoringOwners[report.harness] !== assessment.scoringGroup))) {
      throw new Error(`Canonical scoring metadata does not match the pinned claim ${assessment.ruleId}.`);
    }
    const previous = unique.get(assessment.scoreOwnerKey);
    if (previous && canonicalAiValue(previous) !== canonicalAiValue(assessment)) throw new Error(`Conflicting score owner ${assessment.scoreOwnerKey}.`);
    unique.set(assessment.scoreOwnerKey, assessment);
  }
  const assessments = [...unique.values()];
  const contributions = assessments.map(contribution);
  contributions.push(...report.records.map(record => ({
    assessmentKey: canonicalAiValue(['record', report.harness, record.ruleId, record.subjectId]),
    scoreOwnerKey: canonicalAiValue(['record', report.harness, record.ruleId, record.subjectId]),
    ruleId: record.ruleId, subjectId: record.subjectId, scoringGroup: null,
    status: 'informational' as const, scoreEffect: 'none' as const,
    catalogWeight: 0, earnedWeight: 0, possibleWeight: 0, pendingWeight: 0, reason: record.fact,
  })));
  for (const assessment of assessments) {
    if (assessment.scoringGroup === null || !Object.hasOwn(defaultPolicy.weights, assessment.scoringGroup)
      || assessment.catalogWeight <= 0) blockers.push(`Missing scoring ownership/weight for ${assessment.ruleId}.`);
  }
  const harnessPolicy = HARNESS_POLICY[report.harness];
  const evaluation = Object.hasOwn(defaultPolicy.weights, 'evaluation') ? evaluationScore(options.evaluation) : undefined;
  const groups = (Object.keys(defaultPolicy.weights) as AiReviewGroup[]).map((id): AiGroupScore => {
    const label = harnessPolicy.labels[id] ?? groupLabels[id];
    const nominal = policy.weights[id];
    const validWeight = typeof nominal === 'number' && Number.isFinite(nominal) && nominal > 0
      && nominal === defaultPolicy.weights[id];
    if (!validWeight) blockers.push(`The approved nominal weight for ${label} is missing or changed.`);
    const rows = assessments.filter(item => item.scoringGroup === id);
    const values = contributions.filter(item => item.scoringGroup === id);
    const coverage = groupCoverage(rows);
    const earnedWeight = values.reduce((sum, value) => sum + value.earnedWeight, 0);
    const possibleWeight = values.reduce((sum, value) => sum + value.possibleWeight, 0);
    const pendingWeight = values.reduce((sum, value) => sum + value.pendingWeight, 0);
    const declaredExclusion = options.excludedGroups?.[id];
    if (declaredExclusion && (!declaredExclusion.reason.trim() || rows.some(row => row.applicability.state !== 'not-applicable'))) {
      throw new Error(`The ${id} scope exclusion conflicts with expected applicable assessments or has no reason.`);
    }
    const base = {
      id, label, nominalWeight: validWeight ? nominal : null, effectiveWeight: null,
      earnedWeight, possibleWeight, pendingWeight, coverage,
    };
    const excluded = !!declaredExclusion || rows.length > 0 && coverage.excluded === coverage.expected
      && report.coverage.manifestComplete && report.coverage.deterministic.complete;
    let reason = declaredExclusion?.reason ?? '';
    // The one scorer. These rows are translated into the same rule-result shape a deterministic
    // review produces and handed to the function that scores a Copilot agent's pillars, so an AI
    // finding and a hand-written check are graded by one arithmetic rather than two that merely
    // looked alike. Evaluation still scores from captured evidence, which is a different input and
    // not a second copy of this formula.
    let value = excluded ? null : id === 'evaluation' ? evaluation?.value ?? null
      : scoreLegacyDeterministicRules(aiRuleResults(rows)).score;
    let status: AiGroupScore['status'] = excluded ? 'excluded' : value === null ? 'unavailable'
      : coverage.complete && (id !== 'evaluation' || evaluation?.complete) ? 'scored' : 'provisional';
    if (id === 'evaluation') {
      reason = evaluation?.reason ?? 'Evaluation evidence is unavailable.';
      if (excluded) {
        value = null;
        status = 'unavailable';
        blockers.push('Agent Evaluation cannot be silently excluded or redistributed to other pillars.');
      }
    } else if (!reason) reason = excluded ? 'Every expected quality claim in this declared group is host-excluded.'
      : value === null ? 'No completed applicable rule weight is available; this is not proof of non-applicability.'
        : coverage.complete ? 'The declared quality assessments are complete.' : 'The score covers assessed checks only; required coverage remains incomplete.';
    return {
      ...base, status, value: value === null ? null : Math.round(value), unroundedValue: value, reason,
    };
  });
  notes.push(...harnessPolicy.disclosures);
  const active = groups.filter(group => group.status !== 'excluded');
  const unavailable = active.filter(group => group.unroundedValue === null);
  for (const group of unavailable) blockers.push(`${group.label} is required but unavailable; its weight was not redistributed.`);
  if (!active.length) blockers.push('There are no applicable measurable groups.');
  const calculable = blockers.length === 0 && active.length > 0;
  let composite: number | null = null;
  if (calculable) {
    // One renormalization for every harness, and the same one ART's own composite applies: a
    // pillar that keeps its weight whatever happens holds its declared share, and the groups that
    // can legitimately be absent share what is left in proportion to their declared weight.
    // Redistributing an absent group's weight onto Evaluation would let not having tools raise the
    // price of not testing — two unrelated judgements, compounded.
    //
    // The skill rubric declares no unconditional dimension, so `pinned` is empty there and this is
    // the plain renormalization it has always used. For an agent with nothing excluded the
    // conditional weights already total the remaining share, so it is the identity. Only an agent
    // with a genuinely excluded pillar moves, and it moves onto ART's number.
    const pinnedIds = new Set<string>(UNCONDITIONAL_AGENT_PILLARS);
    const pinned = active.filter(group => pinnedIds.has(group.id));
    const pool = active.filter(group => !pinnedIds.has(group.id));
    const pinnedWeight = pinned.reduce((sum, group) => sum + (group.nominalWeight ?? 0), 0);
    const poolWeight = pool.reduce((sum, group) => sum + (group.nominalWeight ?? 0), 0);
    // Nothing conditional left to score: the unconditional pillars are the whole review and
    // renormalize among themselves. Holding 30 of 100 here would cap a fully evaluated agent at 30.
    const pinnedShare = pool.length === 0 ? 100 : pinnedWeight;
    const poolShare = 100 - pinnedShare;
    composite = 0;
    const share = (group: AiGroupScore, pot: number, total: number): number =>
      total === 0 ? 0 : pot * group.nominalWeight! / total;
    for (const group of pinned) {
      group.effectiveWeight = share(group, pinnedShare, pinnedWeight);
      composite += group.unroundedValue! * group.effectiveWeight / 100;
    }
    for (const group of pool) {
      group.effectiveWeight = share(group, poolShare, poolWeight);
      composite += group.unroundedValue! * group.effectiveWeight / 100;
    }
  }
  const incomplete = report.coverage.incomplete || groups.some(group => group.status === 'provisional');
  if (incomplete) notes.push('Required provider, source or deterministic execution coverage remains incomplete.');
  const complete = composite !== null && !incomplete;
  return {
    policyVersion: AI_REVIEW_POLICY_VERSION,
    profile: harnessPolicy.profile,
    contributions, groups, coverage: structuredClone(report.coverage),
    overall: {
      status: complete ? 'complete' : composite !== null ? 'provisional' : 'unavailable',
      value: complete && composite !== null ? Math.round(composite) : null, unroundedValue: complete ? composite : null,
      provisionalValue: !complete && composite !== null ? Math.round(composite) : null,
      provisionalUnroundedValue: !complete ? composite : null,
      reasons: [...new Set([...blockers, ...notes])],
    },
  };
}

/** The saved request supplies every native provider and scoring signal; no recaptured context is accepted. */
export async function scoreAiWorkflowReview(
  snapshot: AiWorkflowReviewSnapshot,
): Promise<{ ledger: MergedAiReview; score: AiReviewScore }> {
  const frozen = await validateFrozenAiWorkflowSnapshot(snapshot);
  const ledger = mergeAiWorkflowReview(frozen);
  return { ledger, score: scoreAiReview(ledger) };
}
