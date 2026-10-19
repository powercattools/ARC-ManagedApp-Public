import {
  AI_REVIEW_POLICY_VERSION, AI_RULE_CATALOG, aiScoreOwnerKey, canonicalAiValue, getAiRuleDefinition,
  type AiReviewGroup, type AiReviewHarness,
} from './ai-review-catalog';
import { validationProfile } from '../validation/ai-nodes/catalog';
import { validateNodeInput } from '../validation/ai-nodes/validate-input';
import { frozenAiWorkflowContext, MISSING_FROZEN_NATIVE_LEDGER } from './ai-review-source';
import {
  fieldKey, type Evidence, type ExpectedAssessment, type NodeInput,
} from '../validation/ai-nodes/contracts';
import type {
  AiDeterministicAssessment, AiMergeIssue, AiProviderDecision, AiReviewAssessment, AiReviewCoverage,
  AiReviewEvidence, AiReviewRecord, AiReviewUnit, AiWorkflowLedgerContext, AiWorkflowReviewSnapshot,
  MergeAiReviewInput, MergedAiReview,
} from './ai-review-contracts';
export type {
  AiDeterministicAssessment, AiMergeIssue, AiProviderDecision, AiReviewAssessment, AiReviewCoverage,
  AiReviewEvidence, AiReviewFinding, AiReviewRecord, AiReviewUnit, ArtifactDeterministicAssessment,
  AiWorkflowCoverageInput, AiWorkflowLedgerContext, AiWorkflowReviewSnapshot, AiWorkflowSourceBinding,
  MergeAiReviewInput, MergedAiReview,
} from './ai-review-contracts';

const familyGroups: Readonly<Record<string, AiReviewGroup>> = {
  Instructions: 'instructions', Skills: 'skills', Topics: 'skills', Tools: 'tools',
  Knowledge: 'knowledge', Orchestration: 'orchestration', 'Connected agents': 'orchestration', Evaluation: 'evaluation',
};
const asEvidence = (items: readonly Evidence[]): AiReviewEvidence[] => items.map(item => ({ ...item, status: 'verified' }));
const unique = <T,>(items: readonly T[]): T[] => [...new Map(items.map(item => [canonicalAiValue(item), item])).values()];
const completed = (outcome: string): outcome is 'pass' | 'fail' => outcome === 'pass' || outcome === 'fail';

/**
 * Every quote an AI decision rests on must be a literal substring of a frozen source the
 * model was actually shown, and that source must be one the expected assessment permitted.
 * This is the acceptance gate for *every* AI decision, so it is deliberately strict: a
 * model-authored paraphrase is not evidence.
 */
export function isAiReviewEvidenceGrounded(evidence: readonly Evidence[], expected: ExpectedAssessment, input: NodeInput): boolean {
  return evidence.every(item => {
    const key = fieldKey(item);
    const source = input.sources.find(value => fieldKey(value) === key);
    if (!source || source.availability === 'unavailable' || !expected.allowedFields.some(field => fieldKey(field) === key)) return false;
    return item.kind === 'quote' ? !!item.quote && source.content.includes(item.quote)
      : item.kind === 'reviewed-field' && item.quote === '' && source.availability === 'complete'
        && expected.allowedAbsenceFields.some(field => fieldKey(field) === key);
  });
}

function provider(unit: AiReviewUnit, expected: ExpectedAssessment): AiProviderDecision {
  const result = unit.validation;
  const matches = result?.assessments.filter(value => value.assessmentKey === expected.assessmentKey) ?? [];
  const value = matches.length === 1 ? matches[0] : undefined;
  let reason = 'No accepted AI decision was supplied for this expected key.';
  let accepted = false;
  if (result && result.unitId === unit.input.unitId && result.expectedAssessmentCount === unit.input.expectedAssessments.length
    && value && value.ruleId === expected.ruleId && value.subjectId === expected.subjectId
    && !(unit.issues ?? []).some(issue => !result.issues.some(problem => canonicalAiValue(problem) === canonicalAiValue(issue)))
    && !result.issues.some(issue => issue.assessmentKey === expected.assessmentKey)) {
    const completeScope = expected.requiredFields.length > 0 && expected.requiredFields.every(field =>
      unit.input.sources.find(source => fieldKey(source) === fieldKey(field))?.availability === 'complete');
    const reference = value.completionReference;
    const inferred = value.decisionBasis === 'inferred-from-complete-exceptions';
    const validInference = inferred && result.accepted && result.processingComplete && value.outcome === 'pass'
      && value.scopeStatus === 'complete' && completeScope && reference?.responseContract === 'arc2-exceptions-v1'
      && reference.unitId === unit.input.unitId && reference.inputId === unit.input.inputId
      && reference.processedAllExpectedRules === true && value.findings.length === 0;
    const validFailure = value.decisionBasis === 'reported-failure' && value.outcome === 'fail'
      && value.findings.length > 0 && value.findings.every(finding => finding.evidence.length > 0);
    const validUnassessed = value.decisionBasis === 'reported-not-assessed'
      && value.outcome === 'not-assessed' && !!value.reason.trim() && value.findings.length === 0;
    const evidence = [...value.evidence, ...value.findings.flatMap(finding => finding.evidence),
      ...value.observations.flatMap(observation => observation.evidence)];
    accepted = expected.applicability.state === 'applicable' && (validInference || validFailure || validUnassessed)
      && isAiReviewEvidenceGrounded(evidence, expected, unit.input)
      && (value.scopeStatus !== 'complete' || completeScope);
    if (accepted) reason = value.reason || 'The strict normalizer established this expected decision.';
  }
  return {
    unitId: unit.input.unitId, inputId: unit.input.inputId, accepted, unitAccepted: result?.accepted === true,
    processingComplete: result?.processingComplete === true,
    expected: structuredClone(expected), ...(value ? { assessment: structuredClone(value) } : {}), reason,
  };
}

function deterministicAssessment(value: AiDeterministicAssessment, subjectId: string): AiReviewAssessment {
  const key = aiScoreOwnerKey(value.harness, value.ruleId, subjectId);
  const excluded = value.outcome === 'not-applicable';
  const group = value.harness === 'skill' ? value.scoringGroup
    : Object.hasOwn(familyGroups, value.family) ? familyGroups[value.family] : null;
  return {
    kind: 'check', assessmentKey: value.key, scoreOwnerKey: key, ruleId: value.ruleId, subjectId,
    title: value.title, fact: value.fact, why: value.why, fix: value.fix, tags: [...value.tags],
    severity: value.severity, catalogWeight: value.severity === 'high' ? 1 : value.severity === 'medium' ? 0.5 : 0,
    scoringGroup: group, outcome: completed(value.outcome) ? value.outcome : 'not-assessed',
    applicability: { state: excluded ? 'not-applicable' : value.outcome === 'could-not-run' ? 'not-assessed' : 'applicable',
      reason: value.reason || (excluded ? 'The deterministic applicability predicate excludes this claim.' : 'The deterministic execution ledger declares this claim.') },
    decisionSource: 'deterministic', decisionBasis: 'deterministic-outcome', reason: value.reason ?? '', resolution: '',
    incomplete: value.incomplete || value.outcome === 'could-not-run', aiCoverage: 'not-required',
    evidence: structuredClone(value.evidence),
    findings: value.findings.map(finding => ({
      assessmentKey: value.key, ruleId: value.ruleId, subjectId, fact: finding.fact, evidence: structuredClone(finding.evidence),
    })),
    providers: { ai: [], deterministic: [structuredClone(value)], declaredDeterministic: [] },
  };
}

interface Claim { expected: ExpectedAssessment; unit: AiReviewUnit }

function mergedClaim(
  harness: AiReviewHarness, claims: readonly Claim[], deterministic: AiDeterministicAssessment | undefined,
  issues: AiMergeIssue[],
): AiReviewAssessment {
  const { expected } = claims[0];
  const definition = getAiRuleDefinition(expected.ruleId, harness);
  const key = aiScoreOwnerKey(harness, expected.ruleId, expected.subjectId);
  const providers = claims.map(claim => provider(claim.unit, claim.expected));
  const states = new Set(claims.map(claim => claim.expected.applicability.state));
  let conflict = states.size > 1;
  const scopes = new Map<string, string>();
  for (const item of providers.filter(item => item.accepted && item.assessment && completed(item.assessment.outcome))) {
    const scope = canonicalAiValue(item.expected.requiredFields.map(fieldKey).sort());
    const previous = scopes.get(scope);
    if (previous && previous !== item.assessment!.outcome) conflict = true;
    scopes.set(scope, item.assessment!.outcome);
  }
  if (conflict) issues.push({ code: 'conflicting-claim', assessmentKey: key,
    message: 'Repeated provider decisions disagree for the same claim/scope; no last-write-wins decision is allowed.' });
  const excluded = !conflict && expected.applicability.state === 'not-applicable';
  const accepted = conflict ? [] : providers.filter(item => item.accepted && item.assessment);
  const failures = accepted.filter(item => item.assessment?.outcome === 'fail');
  const allComplete = accepted.length === providers.length && accepted.every(item =>
    item.unitAccepted && item.processingComplete && item.assessment
      && completed(item.assessment.outcome) && item.assessment.scopeStatus === 'complete');
  const decisions = failures.length ? failures : allComplete ? accepted : [];
  const selected = decisions[0]?.assessment;
  const reason = excluded ? expected.applicability.reason : expected.applicability.state === 'not-assessed'
    ? expected.applicability.reason : conflict ? 'Conflicting repeated AI decisions require a new accepted result.'
      : accepted.find(item => item.assessment?.outcome === 'not-assessed')?.assessment?.reason
        ?? providers.find(item => !item.accepted)?.reason ?? 'Required AI scope has not been completely assessed.';
  const canonical: AiReviewAssessment = {
    kind: 'check', assessmentKey: expected.assessmentKey, scoreOwnerKey: key, ruleId: definition.id, subjectId: expected.subjectId,
    title: definition.contract.title, question: definition.contract.question, fact: selected?.fact ?? reason,
    why: definition.contract.why, fix: definition.contract.fix, tags: [...definition.tags],
    severity: definition.severity, catalogWeight: definition.catalogWeight,
    scoringGroup: definition.scoringOwners[harness] ?? null,
    outcome: selected?.outcome ?? 'not-assessed',
    applicability: conflict ? { state: 'not-assessed', reason } : structuredClone(expected.applicability),
    decisionSource: selected ? 'ai' : 'host', decisionBasis: selected?.decisionBasis ?? (excluded ? 'host-excluded' : 'host-unavailable'),
    reason: selected?.reason ?? reason, resolution: '',
    incomplete: !excluded && !allComplete, aiCoverage: excluded ? 'excluded' : allComplete ? 'complete' : 'partial',
    evidence: unique(decisions.flatMap(item => asEvidence(item.assessment?.evidence ?? []))),
    findings: unique(decisions.flatMap(item => item.assessment?.findings ?? []).map(finding => ({
      assessmentKey: expected.assessmentKey, ruleId: definition.id, subjectId: expected.subjectId,
      fact: finding.fact, evidence: asEvidence(finding.evidence),
      ...(finding.remediation ? { remediation: structuredClone(finding.remediation) } : {}),
    }))),
    providers: { ai: providers, deterministic: deterministic ? [structuredClone(deterministic)] : [],
      declaredDeterministic: claims.flatMap(claim => claim.expected.deterministicAssessment
        ? [structuredClone(claim.expected.deterministicAssessment)] : []) },
  };
  return canonical;
}

/** Merge only frozen inputs and strict-normalizer results. Raw/legacy model output is not a supported input. */
export function mergeAiReview(input: MergeAiReviewInput): MergedAiReview {
  if (!input.subjectId.trim()) throw new Error('The captured review subject is required.');
  const issues: AiMergeIssue[] = structuredClone([...(input.workflow?.issues ?? [])]);
  const workflow = input.workflow ? {
    jobId: input.workflow.parent.jobId, parentState: input.workflow.parent.state,
    transportComplete: input.workflow.transportComplete, reviewComplete: input.workflow.reviewComplete,
  } : undefined;
  const workflowComplete = !workflow || (workflow.parentState === 'succeeded'
    && workflow.transportComplete && workflow.reviewComplete && issues.length === 0);
  if (workflow && input.units.some(unit => unit.input.jobId !== workflow.jobId)) {
    throw new Error('Workflow coverage belongs to a different frozen review job.');
  }
  if (!workflowComplete) issues.push({
    code: 'workflow-incomplete', path: 'workflow',
    message: `The parent workflow is ${workflow?.parentState}; complete transport and validated review coverage have not both been established.`,
  });
  const records: AiReviewRecord[] = [];
  const claims = new Map<string, Claim[]>();
  const units = new Map<string, AiReviewUnit>();
  const sourceValues = new Map<string, string>();
  let identity: string | undefined;
  for (const original of input.units) {
    const unit = structuredClone(original);
    const previous = units.get(unit.input.unitId);
    if (previous) {
      if (canonicalAiValue(previous) === canonicalAiValue(unit)) continue;
      throw new Error(`Conflicting repeated AI unit ${unit.input.unitId}; select an exact attempt before merging.`);
    }
    const nodeIssues = validateNodeInput(unit.input, validationProfile(unit.input.unitKind,
      unit.input.expectedAssessments.map(item => item.subjectId)));
    if (nodeIssues.length || unit.input.expectedRecords.length) {
      throw new Error(`Invalid frozen AI manifest ${unit.input.unitId}: ${nodeIssues.map(item => item.message).join('; ') || 'Compact records are not supported.'}`);
    }
    const candidateIdentity = canonicalAiValue([unit.input.jobId, unit.input.correlationId]);
    if (identity && candidateIdentity !== identity) throw new Error('AI inputs from different jobs/correlations cannot share a report.');
    identity = candidateIdentity;
    if ((input.harness === 'standard') !== (unit.input.unitKind === 'standard')
      || (input.harness === 'skill') !== (unit.input.unitKind === 'standalone-skill')
      || (input.harness !== 'skill' && unit.input.context?.agentId !== input.subjectId)) {
      throw new Error('The frozen unit belongs to another harness or agent subject.');
    }
    for (const source of unit.input.sources) {
      const key = fieldKey(source);
      const prior = sourceValues.get(key);
      if (prior && prior !== canonicalAiValue(source)) throw new Error(`Conflicting frozen source ${key}.`);
      sourceValues.set(key, canonicalAiValue(source));
    }
    units.set(unit.input.unitId, unit);
    for (const expected of unit.input.expectedAssessments) {
      const definition = getAiRuleDefinition(expected.ruleId, input.harness);
      const subjectMatches = definition.subjectScope === 'agent' ? expected.subjectId === input.subjectId
        : definition.subjectScope === 'skill-set' ? expected.subjectId === `${input.subjectId}:skill-set`
          : input.harness === 'skill' ? expected.subjectId === input.subjectId
            : unit.input.context?.components?.some(component => component.componentType === 'skill' && component.componentId === expected.subjectId);
      if (!subjectMatches) throw new Error(`Rule ${expected.ruleId} does not match its captured subject scope.`);
      const key = aiScoreOwnerKey(input.harness, expected.ruleId, expected.subjectId);
      claims.set(key, [...(claims.get(key) ?? []), { expected, unit }]);
    }
    issues.push(...unique([...(unit.issues ?? []), ...(unit.validation?.issues ?? [])])
      .map(issue => ({ ...issue, unitId: unit.input.unitId })));
  }
  const required = new Map<string, readonly string[]>();
  const registered = AI_RULE_CATALOG.filter(rule => rule.harnesses.includes(input.harness));
  if (input.harness === 'copilot') {
    required.set(input.subjectId, registered.filter(rule => rule.subjectScope === 'agent').map(rule => rule.id));
    required.set(`${input.subjectId}:skill-set`, registered.filter(rule => rule.subjectScope === 'skill-set').map(rule => rule.id));
    const skillIds = new Set([...units.values()].filter(unit => unit.input.unitKind === 'cross-skill')
      .flatMap(unit => unit.input.context?.components?.map(component => component.componentId) ?? []));
    for (const entries of claims.values()) {
      if (getAiRuleDefinition(entries[0].expected.ruleId).subjectScope === 'skill') skillIds.add(entries[0].expected.subjectId);
    }
    for (const id of skillIds) required.set(id, registered.filter(rule => rule.subjectScope === 'skill').map(rule => rule.id));
  } else required.set(input.subjectId, registered.map(rule => rule.id));
  for (const [subject, ids] of required) for (const id of ids) {
    if (!claims.has(aiScoreOwnerKey(input.harness, id, subject))) issues.push({
      code: 'missing-ai-manifest', message: `The expected ${id} assessment for ${subject} is absent from the frozen manifest.`,
    });
  }
  const deterministic = new Map<string, AiDeterministicAssessment>();
  for (const raw of input.deterministicAssessments) {
    if (raw.harness !== input.harness || raw.source !== 'deterministic'
      || (raw.harness === 'skill' && !raw.catalogReference.trim())) throw new Error('A deterministic provider has an invalid harness, source or catalog provenance.');
    if (!['pass', 'fail', 'not-applicable', 'could-not-run'].includes(raw.outcome)
      || !['high', 'medium', 'info'].includes(raw.severity) || !['check', 'record'].includes(raw.kind)
      || ![raw.key, raw.ruleId, raw.title, raw.fact, raw.why, raw.fix].every(value => typeof value === 'string' && value.trim())
      || (raw.outcome === 'could-not-run' && (!raw.incomplete || !raw.reason?.trim()))) {
      throw new Error('The deterministic provider is not an explicit unified assessment; legacy grades and incomplete metadata are unsupported.');
    }
    const definition = AI_RULE_CATALOG.find(item => item.id === raw.ruleId);
    if (definition) {
      throw new Error(`Deterministic provider collides with the AI-only or quality ownership of ${raw.ruleId}.`);
    }
    const subject = raw.subjectId ?? input.subjectId;
    const key = aiScoreOwnerKey(input.harness, raw.ruleId, subject);
    const previous = deterministic.get(key);
    if (previous && canonicalAiValue(previous) !== canonicalAiValue(raw)) throw new Error(`Conflicting deterministic assessments for ${key}.`);
    deterministic.set(key, structuredClone(raw));
  }
  const assessments: AiReviewAssessment[] = [];
  for (const [key, entries] of claims) {
    const scoped = deterministic.get(key);
    assessments.push(mergedClaim(input.harness, entries, scoped, issues));
    if (scoped) deterministic.delete(key);
  }
  for (const raw of deterministic.values()) {
    if (raw.kind === 'record') {
      if (raw.severity !== 'info') throw new Error(`Neutral record ${raw.ruleId} cannot acquire a quality weight.`);
      records.push({ kind: 'record', ruleId: raw.ruleId, subjectId: raw.subjectId ?? input.subjectId,
        title: raw.title, fact: raw.fact, why: raw.why, fix: raw.fix, severity: 'info', catalogWeight: 0,
        decisionSource: 'deterministic', evidence: structuredClone(raw.evidence), provider: raw });
    } else assessments.push(deterministicAssessment(raw, raw.subjectId ?? input.subjectId));
  }
  for (const assessment of assessments) {
    if (!assessment.scoringGroup || assessment.catalogWeight === 0) issues.push({
      code: 'missing-scoring-metadata', assessmentKey: assessment.assessmentKey,
      message: 'A quality check lacks a registered scoring owner or positive weight; it cannot form a complete native score.',
    });
  }
  const aiAssessments = assessments.filter(item => item.aiCoverage !== 'not-required');
  const count = aiAssessments.length;
  const excluded = aiAssessments.filter(item => item.aiCoverage === 'excluded').length;
  const complete = aiAssessments.filter(item => item.aiCoverage === 'complete').length;
  const manifestComplete = !issues.some(issue => issue.code === 'missing-ai-manifest');
  const ai: AiReviewCoverage = {
    expected: count, completed: complete, excluded, pending: count - excluded - complete,
    ratio: count > excluded ? complete / (count - excluded) : null,
    complete: manifestComplete && count - excluded === complete,
  };
  const deterministicCoverage = input.deterministicCoverage
    ? structuredClone(input.deterministicCoverage)
    : { complete: false, reason: 'The host has not supplied a complete deterministic execution ledger.' };
  if (!deterministicCoverage.reason.trim()) throw new Error('Deterministic coverage requires its captured-scope reason.');
  return {
    policyVersion: AI_REVIEW_POLICY_VERSION, harness: input.harness, subjectId: input.subjectId,
    assessments, records, issues,
    coverage: { ai, manifestComplete, deterministic: deterministicCoverage,
      ...(workflow ? { workflow } : {}),
      incomplete: !ai.complete || !deterministicCoverage.complete || assessments.some(item => item.incomplete)
        || !workflowComplete || issues.length > 0 },
  };
}

/** Merge a normalized workflow using only its stored native ledger; production callers use scoreAiWorkflowReview. */
export function mergeAiWorkflowReview(snapshot: AiWorkflowReviewSnapshot, context?: AiWorkflowLedgerContext): MergedAiReview {
  const harness = snapshot.request.harness === 'Standard' ? 'standard'
    : snapshot.request.harness === 'Copilot' ? 'copilot'
      : snapshot.request.harness === 'Skill' ? 'skill' : undefined;
  if (!harness) throw new Error('The loaded workflow has an unsupported review harness.');
  if (snapshot.units.some(unit => unit.input.correlationId !== snapshot.request.review.correlationId)) {
    throw new Error('The loaded workflow and frozen units have different review correlations.');
  }
  if (snapshot.units.some(unit => unit.input.jobId !== snapshot.parent.jobId)
    || snapshot.parent.jobId !== snapshot.request.execution.jobId) {
    throw new Error('The loaded workflow and frozen units have different review jobs.');
  }
  const frozen = frozenAiWorkflowContext(snapshot, context);
  const report = mergeAiReview({
    ...frozen.context, harness, subjectId: snapshot.request.review.botId,
    units: snapshot.units, workflow: snapshot,
  });
  return {
    ...report, frozenScoring: frozen.scoring,
    issues: frozen.sourceBinding.status === 'missing'
      ? [...report.issues, { code: 'missing-frozen-native-ledger', path: 'request/hostReview', message: MISSING_FROZEN_NATIVE_LEDGER }]
      : report.issues,
    coverage: { ...report.coverage, sourceBinding: frozen.sourceBinding },
  };
}
