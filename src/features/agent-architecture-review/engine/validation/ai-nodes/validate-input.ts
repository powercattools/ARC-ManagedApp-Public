import {
  fieldKey,
  isRequiredScopeMetadata,
  VALIDATION_CATALOG_VERSION,
  VALIDATION_SCHEMA_VERSION,
  type Evidence,
  type FieldRef,
  type NodeInput,
  type ValidationIssue,
  type ValidationProfile,
} from './contracts';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');
const field = (value: unknown): value is FieldRef =>
  object(value) && typeof value.componentId === 'string' && typeof value.fieldPath === 'string';
const fields = (value: unknown): value is FieldRef[] => Array.isArray(value) && value.every(field);
const oneOf = (value: unknown, options: readonly string[]): value is string =>
  typeof value === 'string' && options.includes(value);
const evidence = (value: unknown): value is Evidence =>
  field(value) && 'kind' in value && oneOf(value.kind, ['quote', 'reviewed-field'])
    && 'quote' in value && typeof value.quote === 'string';

function inputShape(value: unknown): value is NodeInput {
  if (!object(value)
    || value.schemaVersion !== VALIDATION_SCHEMA_VERSION
    || value.catalogVersion !== VALIDATION_CATALOG_VERSION
    || !oneOf(value.unitKind, ['standard', 'copilot-instructions', 'copilot-skill', 'cross-skill', 'standalone-skill'])
    || !['jobId', 'correlationId', 'unitId', 'inputId'].every(key => typeof value[key] === 'string')
    || !Array.isArray(value.sources) || !Array.isArray(value.expectedAssessments)
    || !Array.isArray(value.rules)
    || !Array.isArray(value.expectedRecords)) return false;
  if (!value.sources.every(source => object(source) && field(source)
    && typeof source.content === 'string'
    && oneOf(source.availability, ['complete', 'partial', 'unavailable'])
    && (source.reason === undefined || typeof source.reason === 'string'))) return false;
  if (value.context !== undefined) {
    const context = value.context;
    if (!object(context)
      || !['agentId', 'agentName', 'scope'].every(key => typeof context[key] === 'string' && context[key].trim())
      || (context.purpose !== undefined && typeof context.purpose !== 'string')
      || (context.orchestrationMode !== undefined && typeof context.orchestrationMode !== 'string')
      || (context.reviewLimits !== undefined && !strings(context.reviewLimits))
      || (context.components !== undefined && (!Array.isArray(context.components)
        || !context.components.every(component => object(component)
          && ['componentId', 'name', 'componentType'].every(key => typeof component[key] === 'string'))))) return false;
    if (context.artifact !== undefined
      && (!object(context.artifact) || context.artifact.kind !== 'skill'
        || !oneOf(context.artifact.binding, ['unbound', 'bound'])
        || typeof context.artifact.sourceSkillId !== 'string' || !context.artifact.sourceSkillId.trim())) return false;
  }
  if (!value.rules.every(rule => {
    if (!object(rule) || !object(rule.applicability) || !object(rule.requiredEvidence)) return false;
    const { applicability, requiredEvidence } = rule;
    return ['ruleId', 'name', 'evaluationQuestion'].every(key => typeof rule[key] === 'string')
      && oneOf(rule.category, ['configuration', 'routing', 'instructions'])
      && strings(rule.failWhen) && strings(rule.rejectWhen)
      && oneOf(applicability.status, ['applicable', 'not-applicable', 'not-assessed'])
      && strings(applicability.eligibleComponentIds)
      && strings(requiredEvidence.allowedFieldPaths)
      && typeof requiredEvidence.allowEmptyQuoteForAbsence === 'boolean';
  })) return false;
  if (!value.expectedAssessments.every(expected => {
    if (!object(expected) || !object(expected.applicability)) return false;
    const applicability = expected.applicability;
    if (!['assessmentKey', 'ruleId', 'subjectId'].every(key => typeof expected[key] === 'string')
      || expected.execution !== 'ai'
      || !oneOf(applicability.state, ['applicable', 'not-applicable', 'not-assessed'])
      || typeof applicability.reason !== 'string'
      || !strings(expected.eligibleComponentIds)
      || !fields(expected.allowedFields) || !fields(expected.allowedAbsenceFields)
      || !fields(expected.requiredFields)) return false;
    const deterministic = expected.deterministicAssessment;
    return deterministic === undefined || (object(deterministic)
      && oneOf(deterministic.outcome, ['pass', 'fail', 'not-assessed'])
      && typeof deterministic.fact === 'string' && Array.isArray(deterministic.evidence)
      && deterministic.evidence.every(evidence));
  })) return false;
  return value.expectedRecords.every(record => object(record)
    && ['recordKey', 'ruleId', 'subjectId'].every(key => typeof record[key] === 'string')
    && fields(record.allowedFields) && fields(record.requiredFields));
}


export function validateNodeInput(
  input: unknown,
  profile: ValidationProfile,
): ValidationIssue[] {
  if (!inputShape(input)) {
    return [{ code: 'input-shape', path: '', message: 'Detailed unit, rule and source structures are invalid or unsupported.' }];
  }
  const issues: ValidationIssue[] = [];
  const issue = (code: string, path: string, message: string) => issues.push({ code, path, message });
  if (input.schemaVersion !== VALIDATION_SCHEMA_VERSION
    || input.catalogVersion !== VALIDATION_CATALOG_VERSION
    || input.unitKind !== profile.kind) {
    issue('input-contract', '', 'The input does not match the pinned node profile.');
  }
  if (input.context?.artifact && input.unitKind !== 'standalone-skill') {
    issue('unexpected-artifact-profile', 'context/artifact', 'An artifact binding must not override an agent-node profile.');
  }
  if (input.unitKind === 'standalone-skill' && !input.context?.artifact) {
    issue('missing-artifact-profile', 'context/artifact', 'A standalone review requires an explicit skill kind and bound/unbound profile.');
  }
  if (input.context?.artifact
    && input.expectedAssessments.some(item => item.subjectId !== input.context?.artifact?.sourceSkillId)) {
    issue('artifact-subject-mismatch', 'context/artifact', 'Standalone assessment subjects must match the declared captured skill.');
  }
  if (input.context?.artifact?.binding === 'unbound'
    && input.expectedAssessments.some(item => item.ruleId === 'SKL-09' && item.applicability.state !== 'not-applicable')) {
    issue('unbound-capability-claim', 'context/artifact', 'An explicitly unbound skill cannot assert a target-agent capability assessment.');
  }
  for (const key of ['jobId', 'correlationId', 'unitId', 'inputId'] as const) {
    if (typeof input[key] !== 'string' || !input[key].trim()) {
      issue('input-identity', key, `A nonempty ${key} is required.`);
    }
  }

  const sources = new Map<string, (typeof input.sources)[number]>();
  for (const [index, source] of input.sources.entries()) {
    const key = fieldKey(source);
    if (sources.has(key)) issue('duplicate-source', `sources/${index}`, 'Source field identities must be unique.');
    if (!source.componentId.trim() || !source.fieldPath.trim() || typeof source.content !== 'string') {
      issue('invalid-source', `sources/${index}`, 'A source requires exact identities and string content.');
    }
    if (!['complete', 'partial', 'unavailable'].includes(source.availability)) {
      issue('invalid-availability', `sources/${index}`, 'Unknown source availability.');
    }
    if (source.availability !== 'complete' && !source.reason?.trim()) {
      issue('missing-source-reason', `sources/${index}`, 'Incomplete source scope requires an explicit reason.');
    }
    if (source.availability === 'unavailable' && source.content !== '') {
      issue('unavailable-source-content', `sources/${index}`, 'Unavailable or withheld source text must not be submitted.');
    }
    sources.set(key, source);
  }

  function checkFields(fields: FieldRef[], path: string, allowed?: Set<string>) {
    const seen = new Set<string>();
    for (const field of fields) {
      const key = fieldKey(field);
      if (seen.has(key)) issue('duplicate-field', path, 'A declared source field is repeated.');
      if (!sources.has(key)) issue('missing-source', path, `No source exists for ${key}.`);
      if (allowed && !allowed.has(key)) issue('disallowed-field', path, `The field ${key} is not permitted.`);
      seen.add(key);
    }
  }

  // The node reads rules[] and nothing else, so the executable-contract gate lives on it.
  const ruleIds = new Set<string>();
  for (const [index, rule] of input.rules.entries()) {
    const path = `rules/${index}`;
    if (!rule.ruleId.trim() || ruleIds.has(rule.ruleId)) {
      issue('duplicate-rule', path, 'Each supplied node rule must occur once under a nonempty id.');
    }
    ruleIds.add(rule.ruleId);
    const pinned = profile.rules.get(rule.ruleId);
    if (!pinned || rule.name !== pinned.rule.title || rule.category !== pinned.rule.category
      || rule.evaluationQuestion !== pinned.rule.question
      || JSON.stringify(rule.failWhen) !== JSON.stringify(pinned.rule.failWhen)
      || JSON.stringify(rule.rejectWhen) !== JSON.stringify(pinned.rule.notApplicableWhen)) {
      issue('unpinned-rule', path, 'The supplied node rule must match the trusted profile definition.');
    }
    if (!rule.name.trim() || !rule.evaluationQuestion.trim() || !rule.failWhen.length
      || [...rule.failWhen, ...rule.rejectWhen].some(clause => !clause.trim())
      || rule.requiredEvidence.allowedFieldPaths.some(fieldPath => !fieldPath.trim())
      || (rule.applicability.status === 'applicable' && !rule.requiredEvidence.allowedFieldPaths.length)) {
      issue('incomplete-rule', path, 'An ID or title alone is not an executable rule contract.');
    }
  }

  const keys = new Set<string>();
  const claims = new Set<string>();
  for (const [index, expected] of input.expectedAssessments.entries()) {
    const path = `expectedAssessments/${index}`;
    const claim = JSON.stringify([expected.ruleId, expected.subjectId]);
    if (!expected.assessmentKey.trim() || keys.has(expected.assessmentKey) || claims.has(claim)) {
      issue('duplicate-expected-assessment', path, 'Each nonempty key and rule/subject claim must occur once.');
    }
    keys.add(expected.assessmentKey);
    claims.add(claim);
    const definition = profile.rules.get(expected.ruleId);
    if (!definition || definition.execution !== expected.execution) {
      issue('unpinned-rule', path, 'The assessment rule must match the trusted profile definition.');
    }
    if (!profile.subjectIds.has(expected.subjectId)) {
      issue('unknown-subject', path, 'The subject is outside this frozen validation case.');
    }
    if (!['applicable', 'not-applicable', 'not-assessed'].includes(expected.applicability.state)
      || !expected.applicability.reason.trim()) {
      issue('invalid-applicability', path, 'Trusted applicability requires a known state and a reason.');
    }
    const allowed = new Set(expected.allowedFields.map(fieldKey));
    if (expected.allowedFields.some(field => isRequiredScopeMetadata(input, expected, field))) {
      issue('scope-metadata-as-evidence', path, 'Host population scope is required context, not authored quotation evidence.');
    }
    checkFields(expected.allowedFields, `${path}/allowedFields`);
    checkFields(expected.allowedAbsenceFields, `${path}/allowedAbsenceFields`, allowed);
    const required = new Set(allowed);
    for (const field of expected.requiredFields) if (isRequiredScopeMetadata(input, expected, field)) required.add(fieldKey(field));
    checkFields(expected.requiredFields, `${path}/requiredFields`, required);
    if (expected.applicability.state === 'applicable' && !expected.requiredFields.length) {
      issue('missing-required-scope', path, 'An applicable rule must declare its required source scope.');
    }
    const eligible = new Set(expected.eligibleComponentIds);
    if (eligible.size !== expected.eligibleComponentIds.length
      || (input.unitKind === 'standard'
        && expected.allowedFields.some(field => !eligible.has(field.componentId)))) {
      issue('invalid-eligible-population', path, 'Allowed evidence must belong to the declared unique eligible population.');
    }
    if (input.unitKind === 'standard'
      && expected.allowedAbsenceFields.some(field => field.fieldPath !== 'fields.instructions')) {
      issue('standard-absence-scope', path, 'Standard absence evidence is restricted to the complete instructions field.');
    }
    if (expected.deterministicAssessment) {
      issue('unexpected-deterministic-owner', path, 'An AI rule does not carry a shared deterministic assessment.');
    }
  }

  const assessed = new Set(input.expectedAssessments.map(expected => expected.ruleId));
  if (ruleIds.size !== assessed.size || [...assessed].some(id => !ruleIds.has(id))) {
    issue('rule-assessment-mismatch', 'rules',
      'The supplied node rules must be exactly the rules this unit expects to be assessed.');
  }

  const recordKeys = new Set<string>();
  const recordClaims = new Set<string>();
  for (const [index, expected] of input.expectedRecords.entries()) {
    const path = `expectedRecords/${index}`;
    const claim = JSON.stringify([expected.ruleId, expected.subjectId]);
    if (!expected.recordKey.trim() || recordKeys.has(expected.recordKey) || recordClaims.has(claim)) {
      issue('duplicate-expected-record', path, 'Informational record keys and rule/subject pairs must be unique.');
    }
    recordKeys.add(expected.recordKey);
    recordClaims.add(claim);
    if (!profile.recordIds.has(expected.ruleId) || !profile.subjectIds.has(expected.subjectId)) {
      issue('unknown-record', path, 'The informational identity is not in the trusted profile.');
    }
    checkFields(expected.allowedFields, `${path}/allowedFields`);
    checkFields(expected.requiredFields, `${path}/requiredFields`, new Set(expected.allowedFields.map(fieldKey)));
    if (!expected.requiredFields.length) {
      issue('missing-record-scope', path, 'An informational record must declare the sources needed to read it.');
    }
  }
  return issues;
}
