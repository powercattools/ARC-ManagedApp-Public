import type { AgentCapture } from '../capture/agent-capture';
import { normalizeStandardComponents } from '../harnesses/standard/standard-component-normalization';
import {
  compareCapturedDeterministicReview, computeCoverage, getUnifiedRuleCatalog, redactSecrets,
  standardNativeEvaluationRules, UNIFIED_COMPARISON_POLICY_VERSION,
  type UnifiedRuleAssessment,
} from '../scoring/art-ports';
import type { AiWorkflowLedgerContext } from '../scoring/ai-review-merge';
import type { AiEvaluationSignals, AiScoringOptions } from '../scoring/ai-review-scoring';
import { capturedCapabilityInventory } from './capability-inventory';
import { standardEvaluationSignals } from './standard-evaluation-signals';
import { canonicalJson } from './provenance';
import { isObject, requireCondition } from './wire-data';
import { buildCapturedAgentRequest, type ProductionReviewRequest } from './request';

export interface NativeLedger {
  contract: 'arc2-native-ledger-v1';
  sourcePolicyVersion: string;
  harness: 'standard' | 'copilot' | 'skill';
  subjectId: string;
  assessments: UnifiedRuleAssessment[];
  coverage: { complete: boolean; reason: string };
  evaluation?: AiEvaluationSignals;
  scope: string[];
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const stringFields = (value: Record<string, unknown>, keys: string[]) => keys.every(key => typeof value[key] === 'string');
const optionalStrings = (value: Record<string, unknown>, keys: string[]) =>
  keys.every(key => value[key] === undefined || typeof value[key] === 'string');
const severity = (value: unknown) => value === 'high' || value === 'medium' || value === 'info';
type NativeEvidence = UnifiedRuleAssessment['evidence'][number];

function evidence(value: unknown): value is NativeEvidence {
  return isObject(value) && typeof value.fieldPath === 'string'
    && optionalStrings(value, ['componentId', 'schemaName', 'quote', 'reason'])
    && (value.status === 'verified' || value.status === 'unverified' || value.status === 'unavailable');
}

function assessment(value: unknown): value is UnifiedRuleAssessment {
  return isObject(value) && stringFields(value, ['key', 'ruleId', 'family', 'title', 'fact', 'why', 'fix'])
    && (value.harness === 'standard' || value.harness === 'copilot')
    && severity(value.severity) && (value.kind === 'check' || value.kind === 'record')
    && (value.outcome === 'pass' || value.outcome === 'fail' || value.outcome === 'not-applicable' || value.outcome === 'could-not-run')
    && value.source === 'deterministic' && typeof value.incomplete === 'boolean'
    && optionalStrings(value, ['subject', 'subjectId', 'reason']) && strings(value.tags) && strings(value.referenceIds)
    && Array.isArray(value.evidence) && value.evidence.every(evidence)
    && Array.isArray(value.findings) && value.findings.every(item => isObject(item)
      && stringFields(item, ['id', 'instanceId', 'title', 'fact', 'why', 'fix']) && severity(item.severity)
      && optionalStrings(item, ['subject', 'subjectId']) && strings(item.referenceIds)
      && Array.isArray(item.evidence) && item.evidence.every(evidence));
}

function evaluation(value: unknown): value is AiEvaluationSignals {
  if (!isObject(value) || typeof value.reason !== 'string' || !value.reason.trim()
    || !['complete', 'partial', 'unavailable'].includes(String(value.availability))) return false;
  const flags = ['hasUsableSet', 'hasCases', 'hasMultiTurnCoverage', 'expectedResponseRequirementSatisfied'];
  const ratio = value.capabilityCoverageRatio;
  return flags.every(key => value[key] === null || typeof value[key] === 'boolean')
    && (ratio === null || typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0 && ratio <= 1);
}

/** No hidden legacy score, arbitrary weight or client-supplied provider is admitted on resume. */
export function parseNativeLedger(
  value: unknown, request: Pick<ProductionReviewRequest, 'harness' | 'review' | 'copilotReview'>,
): NativeLedger {
  requireCondition(isObject(value) && value.contract === 'arc2-native-ledger-v1'
    && Object.keys(value).every(key => ['contract', 'sourcePolicyVersion', 'harness', 'subjectId',
      // `scopedHybrids` stays accepted, and is ignored, so the ledgers already saved on past
      // jobs still parse. Nothing writes it any more.
      'assessments', 'scopedHybrids', 'coverage', 'evaluation', 'scope'].includes(key))
    && value.harness === request.harness.toLowerCase() && value.subjectId === request.review.botId
    && Array.isArray(value.assessments) && value.assessments.every(assessment)
    && isObject(value.coverage) && typeof value.coverage.complete === 'boolean'
    && typeof value.coverage.reason === 'string' && value.coverage.reason.trim()
    && strings(value.scope) && (value.evaluation === undefined || evaluation(value.evaluation)),
  'The frozen deterministic ledger has an unsupported shape, source subject or evaluation signal.');
  const harness = value.harness;
  requireCondition(harness === 'standard' || harness === 'copilot' || harness === 'skill', 'Unsupported native ledger harness.');
  const rows = value.assessments;
  if (harness === 'skill') {
    requireCondition(value.sourcePolicyVersion === 'native-artifact-ledger-unavailable' && !rows.length
      && value.coverage.complete === false && value.evaluation === undefined,
    'Legacy artifact grades cannot stand in for a complete native deterministic ledger.');
  } else {
    requireCondition(value.sourcePolicyVersion === UNIFIED_COMPARISON_POLICY_VERSION, 'Unsupported deterministic policy version.');
    const catalog = new Map([
      ...getUnifiedRuleCatalog(harness),
      ...(harness === 'standard' ? standardNativeEvaluationRules : []),
    ].map(rule => [rule.id, rule]));
    const seen = new Set<string>();
    for (const row of rows) {
      const definition = catalog.get(row.ruleId);
      requireCondition(definition && !seen.has(row.ruleId) && row.harness === harness
        && (row.subjectId === undefined || row.subjectId === request.review.botId)
        && row.key === `${harness}:${row.ruleId}:${row.subjectId ? encodeURIComponent(row.subjectId) : 'agent'}`
        && row.family === definition.family && row.kind === definition.kind && row.severity === definition.severity
        && [row.title, row.fact, row.why, row.fix].every(text => text.trim())
        && canonicalJson(row.tags) === canonicalJson(definition.tags)
        && canonicalJson(row.referenceIds) === canonicalJson(definition.referenceIds)
        && (row.outcome !== 'could-not-run' || row.incomplete && !!row.reason?.trim())
        && (row.outcome !== 'fail' || row.evidence.length > 0 && row.findings.length > 0),
      `Frozen deterministic metadata or execution identity is invalid for ${row.ruleId}.`);
      seen.add(row.ruleId);
    }
    requireCondition(seen.size === catalog.size, 'The frozen deterministic rule population is incomplete.');
    requireCondition(!value.coverage.complete || harness === 'standard' && rows.every(row => !row.incomplete),
      'A BASE-only or incomplete deterministic ledger cannot declare complete native coverage.');
  }
  return {
    contract: 'arc2-native-ledger-v1', sourcePolicyVersion: String(value.sourcePolicyVersion),
    harness, subjectId: String(value.subjectId), assessments: structuredClone(rows),
    coverage: { complete: value.coverage.complete, reason: value.coverage.reason },
    scope: [...value.scope], ...(value.evaluation ? { evaluation: structuredClone(value.evaluation) } : {}),
  };
}

function redactAssessment(row: UnifiedRuleAssessment): UnifiedRuleAssessment {
  const cleanEvidence = (value: NativeEvidence): NativeEvidence => ({
    ...value, ...(value.quote === undefined ? {} : { quote: redactSecrets(value.quote) }),
    ...(value.reason === undefined ? {} : { reason: redactSecrets(value.reason) }),
  });
  return {
    key: row.key, ruleId: row.ruleId, harness: row.harness, family: row.family, severity: row.severity,
    kind: row.kind, outcome: row.outcome, title: redactSecrets(row.title), fact: redactSecrets(row.fact),
    why: redactSecrets(row.why), fix: redactSecrets(row.fix), tags: [...row.tags], source: 'deterministic',
    incomplete: row.incomplete, reason: row.reason === undefined ? undefined : redactSecrets(row.reason),
    subject: row.subject, subjectId: row.subjectId, referenceIds: [...row.referenceIds],
    evidence: row.evidence.map(cleanEvidence),
    findings: row.findings.map(finding => ({
      id: finding.id, instanceId: finding.instanceId, title: redactSecrets(finding.title),
      fact: redactSecrets(finding.fact), why: redactSecrets(finding.why), fix: redactSecrets(finding.fix),
      severity: finding.severity, subject: finding.subject, subjectId: finding.subjectId,
      evidence: finding.evidence.map(cleanEvidence), referenceIds: [...finding.referenceIds],
    })),
  };
}

export function buildNativeLedger(capture: AgentCapture, request = buildCapturedAgentRequest(capture)): NativeLedger {
  const partialPopulation = capture.harness === 'copilot'
    && capturedCapabilityInventory(capture).unreviewedExecutableComponents.length > 0;
  // Normalized once, so the Evaluation provider derives capability coverage from exactly the rows
  // the deterministic rules were decided on rather than a second normalization of the same capture.
  const standardComponents = capture.harness === 'standard' ? normalizeStandardComponents(capture.components) : undefined;
  const comparison = compareCapturedDeterministicReview({
    harness: capture.harness,
    metadata: { botId: capture.botId, name: capture.botName, configuration: capture.configuration },
    components: capture.components,
    standardComponents,
    source: 'live', expectedComponentCount: capture.components.length,
    availability: { configuration: 'complete', components: partialPopulation ? 'partial' : 'complete' },
  });
  const assessments = comparison.current.assessments.map(redactAssessment);
  let signals: AiEvaluationSignals;
  if (capture.harness === 'copilot') {
    const coverage = computeCoverage(capture.model);
    const expected = assessments.find(row => row.ruleId === 'EVL-04');
    const incomplete = capture.model.unknownKinds.length > 0
      || capturedCapabilityInventory(capture).unreviewedExecutableComponents.length > 0 || coverage.basis === 'unverified';
    signals = {
      availability: incomplete ? 'partial' : 'complete',
      reason: `Captured evaluation configuration only; ${coverage.basis} capability coverage is not observed execution success.`,
      hasUsableSet: capture.model.evaluationSets.length > 0 && capture.model.testCases.length > 0,
      hasCases: capture.model.testCases.length > 0,
      capabilityCoverageRatio: coverage.basis === 'unverified' ? null : coverage.total ? coverage.covered / coverage.total : 1,
      hasMultiTurnCoverage: capture.model.multiTurnCases.length > 0,
      expectedResponseRequirementSatisfied: !expected || expected.incomplete || expected.outcome === 'could-not-run'
        ? null : expected.outcome === 'pass' || expected.outcome === 'not-applicable',
    };
  } else {
    signals = standardEvaluationSignals(capture, standardComponents ?? capture.components,
      comparison.evaluation, assessments);
  }
  return parseNativeLedger({
    contract: 'arc2-native-ledger-v1', sourcePolicyVersion: comparison.current.policyVersion,
    harness: capture.harness, subjectId: capture.botId, assessments,
    coverage: {
      complete: capture.harness === 'standard' && assessments.every(row => !row.incomplete),
      reason: capture.harness === 'standard'
        ? 'Captured Standard local and native evaluation registry; source completeness remains explicit.'
        : 'The current Copilot provider covers BASE definitions; per-skill L0, bundle and EVL-02 instance ledgers are not yet a complete native provider.',
    },
    evaluation: signals, scope: [...comparison.scope,
      'Connected-agent references cover parent routing metadata, not a recursive review of child internals.'],
  }, request);
}

export function unboundSkillLedger(subjectId: string): NativeLedger {
  return {
    contract: 'arc2-native-ledger-v1', sourcePolicyVersion: 'native-artifact-ledger-unavailable',
    harness: 'skill', subjectId, assessments: [],
    coverage: { complete: false, reason: 'Standalone AI findings are available; a complete native deterministic artifact ledger is not yet connected.' },
    scope: ['Explicitly unbound skill; no parent capabilities or agent Evaluation pillar are inherited.'],
  };
}

export function nativeLedgerContext(ledger: NativeLedger): { context: AiWorkflowLedgerContext; options: AiScoringOptions } {
  return {
    context: { deterministicAssessments: [...ledger.assessments], deterministicCoverage: ledger.coverage },
    options: ledger.evaluation ? { evaluation: ledger.evaluation } : {},
  };
}
