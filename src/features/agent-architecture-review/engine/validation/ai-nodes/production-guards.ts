import type { ExceptionOutput, ExceptionSchemaGuards } from './compact-output';
import type {
  Assessment, Evidence, Finding, InformationalRecord, NodeKind, NodeOutput, Remediation,
} from './contracts';
import { VALIDATION_RULES } from './catalog';

type Guard<T> = (value: unknown) => value is T;

/**
 * Derived from the catalog rather than restated, so a newly catalogued rule reaches its node
 * instead of being rejected here as an unknown ruleId. production-guards.test.ts pins the
 * derived population against the frozen per-node rule sets.
 */
const rulesFor = (kind: NodeKind): readonly string[] =>
  VALIDATION_RULES.filter(rule => rule.nodes.includes(kind)).map(rule => rule.id);
const ruleIds: Record<NodeKind, readonly string[]> = {
  standard: rulesFor('standard'),
  'copilot-instructions': rulesFor('copilot-instructions'),
  'copilot-skill': rulesFor('copilot-skill'),
  'cross-skill': rulesFor('cross-skill'),
  'standalone-skill': rulesFor('standalone-skill'),
};
const recordIds = [
  'KNW-04', 'MDL-01', 'KNW-01', 'TOL-01', 'CON-04', 'LCY-01', 'LCY-02', 'EVL-03', 'EVL-06',
];

function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const key in value) {
    if (!keys.includes(key)) return false;
  }
  return true;
}

function text(value: unknown, maxLength = 4000, minLength = 1): value is string {
  if (typeof value !== 'string') return false;
  // JSON Schema counts Unicode code points, not UTF-16 code units; whitespace is not trimmed.
  let length = 0;
  for (const _character of value) {
    if (++length > maxLength) return false;
  }
  return length >= minLength;
}

function enumText<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === 'string' && choices.some(choice => choice === value);
}

function array<T>(value: unknown, item: Guard<T>, maxItems = 200, minItems = 0): value is T[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) return false;
  // Check sparse slots too, without trusting an array's potentially overridden iterator.
  for (let index = 0; index < value.length; index++) {
    if (!item(value[index])) return false;
  }
  return true;
}

function availability(value: unknown): value is Assessment['scopeStatus'] {
  return enumText(value, ['complete', 'partial', 'unavailable']);
}

function evidence(value: unknown): value is Evidence {
  return object(value, ['componentId', 'fieldPath', 'kind', 'quote'])
    && text(value.componentId, 200)
    && text(value.fieldPath, 500)
    && enumText(value.kind, ['quote', 'reviewed-field'])
    && text(value.quote, 6000, 0);
}

function remediation(value: unknown): value is Remediation {
  return object(value, ['findingTitle', 'whyItMatters', 'makerAction', 'acceptanceCheck', 'suggestedText'])
    && text(value.findingTitle, 200)
    && text(value.whyItMatters, 2000)
    && text(value.makerAction, 2000)
    && text(value.acceptanceCheck, 2000)
    // node-package/schema.mjs:19-20 — optional, but non-empty when present.
    && (value.suggestedText === undefined || text(value.suggestedText, 4000));
}

function observation(value: unknown): value is Assessment['observations'][number] {
  return object(value, ['kind', 'fact', 'evidence'])
    && text(value.kind, 100)
    && text(value.fact, 2000)
    && array(value.evidence, evidence, 20);
}

function record(value: unknown): value is InformationalRecord {
  return object(value, ['recordKey', 'ruleId', 'subjectId', 'availability', 'fact', 'reason', 'evidence'])
    && text(value.recordKey, 500)
    && enumText(value.ruleId, recordIds)
    && text(value.subjectId, 200)
    && availability(value.availability)
    && text(value.fact)
    && text(value.reason, 2000, 0)
    && array(value.evidence, evidence, 30);
}

/**
 * Browser-safe, nonmutating shape guards for compact-schema.mjs and the historical
 * full-V3 ready schemas. Evidence, identity and coverage semantics remain in the validators.
 */
export function productionExceptionGuards(kind: NodeKind): ExceptionSchemaGuards {
  const finding = (value: unknown): value is Finding =>
    object(value, ['fact', 'evidence', 'remediation'])
      && text(value.fact)
      && array(value.evidence, evidence, 30, 1)
      && remediation(value.remediation);

  const assessment = (value: unknown): value is Assessment =>
    object(value, [
      'assessmentKey', 'ruleId', 'subjectId', 'outcome', 'scopeStatus', 'fact', 'reason',
      // `hybridResolution` stays in the accepted-key list only so payloads from the live
      // flow, whose schema still declares it, are not rejected here. It carries no meaning.
      'evidence', 'findings', 'observations', 'hybridResolution',
    ])
      && text(value.assessmentKey, 500)
      && enumText(value.ruleId, ruleIds[kind])
      && text(value.subjectId, 200)
      && enumText(value.outcome, ['pass', 'fail', 'not-assessed'])
      && availability(value.scopeStatus)
      && text(value.fact)
      && text(value.reason, 2000, 0)
      && array(value.evidence, evidence, 30)
      && array(value.findings, finding, 100)
      && array(value.observations, observation, 100)
      // Nothing consumes a hybrid resolution. The live flow's schema still declares the field
      // required, so its shape is still validated here to keep these guards mirroring the schema
      // the model is constrained by. Delete when the flow's schema drops the field.
      && text(value.hybridResolution, 2000, 0);

  const canonicalOutput = (value: unknown): value is NodeOutput =>
    object(value, [
      'schemaVersion', 'catalogVersion', 'jobId', 'correlationId', 'unitId', 'inputId',
      'status', 'assessments', 'records',
    ])
      && value.schemaVersion === 3
      && value.catalogVersion === 'arc2-ai-rules-v1'
      && text(value.jobId, 100)
      && text(value.correlationId, 100)
      && text(value.unitId, 200)
      && text(value.inputId, 200)
      && enumText(value.status, ['complete', 'partial'])
      && array(value.assessments, assessment)
      && array(value.records, record, 50);

  const failure = (value: unknown): value is ExceptionOutput['failures'][number] =>
    object(value, ['assessmentKey', 'scopeStatus', 'findings'])
      && text(value.assessmentKey, 500)
      && availability(value.scopeStatus)
      && array(value.findings, finding, 100, 1);

  const notAssessed = (value: unknown): value is ExceptionOutput['notAssessed'][number] =>
    object(value, ['assessmentKey', 'scopeStatus', 'reason', 'evidence'])
      && text(value.assessmentKey, 500)
      && availability(value.scopeStatus)
      && text(value.reason, 2000)
      && array(value.evidence, evidence, 30);

  // Nothing consumes a hybrid resolution. The live flow's schema still declares `hybridResolutions`
  // required, so its shape is still validated to keep these guards mirroring that schema.
  type WireHybridResolution = { assessmentKey: string; explanation: string; evidence: unknown[] };
  const hybridResolution = (value: unknown): value is WireHybridResolution =>
    object(value, ['assessmentKey', 'explanation', 'evidence'])
      && text(value.assessmentKey, 500)
      && text(value.explanation, 2000)
      && array(value.evidence, evidence, 30, 1);

  const output = (value: unknown): value is ExceptionOutput =>
    object(value, [
      'responseContract', 'unitId', 'inputId', 'processedAllExpectedRules',
      // `hybridResolutions` stays in the accepted-key list only so payloads from the live
      // flow, whose schema still declares it required, are not rejected here. It is ignored.
      'failures', 'notAssessed', 'hybridResolutions',
    ])
      && value.responseContract === 'arc2-exceptions-v1'
      && text(value.unitId, 200)
      && text(value.inputId, 200)
      && typeof value.processedAllExpectedRules === 'boolean'
      && array(value.failures, failure)
      && array(value.notAssessed, notAssessed)
      && array(value.hybridResolutions, hybridResolution);

  return { output, canonical: { output: canonicalOutput, assessment, record } };
}
