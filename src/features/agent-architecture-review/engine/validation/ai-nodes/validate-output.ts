import {
  fieldKey,
  type Assessment,
  type Evidence,
  type FieldRef,
  type InformationalRecord,
  type NodeInput,
  type NodeSchemaGuards,
  type ValidatedNodeResult,
  type ValidationIssue,
} from './contracts';
import { validationRuleContract } from './catalog';

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function keyCounts(values: unknown[], key: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (isObject(value) && typeof value[key] === 'string') {
      counts.set(value[key], (counts.get(value[key]) ?? 0) + 1);
    }
  }
  return counts;
}

const REMEDIATION_FIELDS = ['findingTitle', 'whyItMatters', 'makerAction', 'acceptanceCheck'] as const;

/**
 * Schema guards are boolean predicates, so a rejected assessment carries no reason of its own.
 * Remediation is required for every node kind, which makes a missing grounded field the most
 * likely cause; naming the owning rule and the absent field keeps that rejection attributable
 * instead of surfacing an unexplained whole-unit failure.
 */
function schemaGap(value: unknown): string {
  if (!isObject(value) || !Array.isArray(value.findings)) return '';
  const gaps: string[] = [];
  for (const [index, finding] of value.findings.entries()) {
    if (!isObject(finding)) continue;
    const remediation = finding.remediation;
    if (remediation === undefined) {
      gaps.push(`findings/${index} is missing remediation`);
      continue;
    }
    if (!isObject(remediation)) {
      gaps.push(`findings/${index} remediation is not an object`);
      continue;
    }
    const missing = REMEDIATION_FIELDS.filter(field => typeof remediation[field] !== 'string' || !remediation[field]);
    if (missing.length) gaps.push(`findings/${index} remediation is missing ${missing.join(', ')}`);
    if (remediation.suggestedText === '') gaps.push(`findings/${index} suggestedText must be omitted rather than empty`);
  }
  return gaps.length ? ` ${gaps.join('; ')}.` : '';
}

/** The caller first validates the frozen input and binds guards to its exact node schema. */
export function validateNodeOutput(
  input: NodeInput,
  raw: unknown,
  schema: NodeSchemaGuards,
): ValidatedNodeResult {
  const issues: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const assessments: Assessment[] = [];
  const records: InformationalRecord[] = [];
  const issue = (code: string, path: string, message: string, owner?: { assessmentKey?: string; recordKey?: string }) =>
    issues.push({ code, path, message, ...owner });
  const warn = (code: string, path: string, message: string, owner?: { assessmentKey?: string; recordKey?: string }) =>
    warnings.push({ code, path, message, ...owner });
  const finish = (partial: boolean): ValidatedNodeResult => ({
    unitId: input.unitId,
    accepted: issues.length === 0,
    coverage: partial || issues.length ? 'partial' : 'complete',
    expectedAssessmentCount: input.expectedAssessments.length,
    assessments,
    records,
    issues,
    warnings,
  });

  if (!isObject(raw)) {
    issue('invalid-output', '', 'The node returned no JSON object.');
    return finish(true);
  }
  for (const key of ['schemaVersion', 'catalogVersion', 'jobId', 'correlationId', 'unitId', 'inputId'] as const) {
    if (raw[key] !== input[key]) issue('identity-mismatch', key, `${key} does not match the frozen unit.`);
  }
  if (issues.length) return finish(true);
  if (!schema.output(raw)) issue('output-schema', '', 'The raw output violates the frozen node-specific JSON schema.');
  if (!Array.isArray(raw.assessments) || !Array.isArray(raw.records)) return finish(true);

  const sources = new Map(input.sources.map(source => [fieldKey(source), source]));
  if (sources.size !== input.sources.length) {
    issue('ambiguous-input-source', '', 'Duplicate input sources cannot be resolved by choosing one.');
    return finish(true);
  }
  let incomplete = raw.status === 'partial';
  const requiredComplete = (fields: FieldRef[]) =>
    fields.every(field => sources.get(fieldKey(field))?.availability === 'complete');

  function evidenceIssues(
    evidence: Evidence[],
    allowedFields: FieldRef[],
    absenceFields: FieldRef[],
    path: string,
    owner: { assessmentKey?: string; recordKey?: string },
  ) {
    const allowed = new Set(allowedFields.map(fieldKey));
    const absence = new Set(absenceFields.map(fieldKey));
    for (const [index, item] of evidence.entries()) {
      const itemPath = `${path}/${index}`;
      const key = fieldKey(item);
      const source = sources.get(key);
      if (!allowed.has(key) || !source || source.availability === 'unavailable') {
        issue('disallowed-evidence', itemPath, 'Evidence is outside the permitted readable source scope.', owner);
      } else if (item.kind === 'quote') {
        if (!item.quote || !source.content.includes(item.quote)) {
          issue('nonexact-quote', itemPath, 'A quote must be a nonempty contiguous case-sensitive source substring.', owner);
        }
      } else if (!absence.has(key) || item.quote !== '' || source.availability !== 'complete') {
        issue('invalid-absence-evidence', itemPath, 'Complete-field absence evidence is not authorized for this source.', owner);
      }
    }
  }

  const assessmentCounts = keyCounts(raw.assessments, 'assessmentKey');
  const expectedByKey = new Map(input.expectedAssessments.map(expected => [expected.assessmentKey, expected]));
  for (const [index, value] of raw.assessments.entries()) {
    const path = `assessments/${index}`;
    if (!schema.assessment(value)) {
      const named = isObject(value) && typeof value.ruleId === 'string' ? ` Rule ${value.ruleId}.` : '';
      issue('assessment-schema', path, `The assessment violates the frozen node schema.${named}${schemaGap(value)}`,
        isObject(value) && typeof value.assessmentKey === 'string' ? { assessmentKey: value.assessmentKey } : undefined);
      continue;
    }
    const owner = { assessmentKey: value.assessmentKey };
    const start = issues.length;
    const expected = expectedByKey.get(value.assessmentKey);
    if (!expected || value.ruleId !== expected.ruleId || value.subjectId !== expected.subjectId) {
      issue('assessment-identity', path, 'The assessment is not an expected rule/subject/key.', owner);
      continue;
    }
    if (assessmentCounts.get(value.assessmentKey) !== 1) {
      issue('duplicate-assessment', path, 'Repeated decisions are rejected, not resolved by first/last write.', owner);
    }
    const excluded = expected.applicability.state === 'not-applicable';
    if (expected.applicability.state !== 'applicable' && value.outcome !== 'not-assessed') {
      issue('applicability-override', path, 'The decision overrides trusted applicability.', owner);
    }
    if (!value.fact.trim()) issue('blank-fact', path, 'An assessment requires a contextual fact.', owner);
    if (value.outcome === 'not-assessed') {
      if (!value.reason.trim()) issue('missing-reason', path, 'Not assessed requires a specific reason.', owner);
      if (!excluded) incomplete = true;
    }
    if (value.outcome !== 'fail' && value.findings.length) {
      issue('outcome-findings-conflict', path, 'Only Fail can contain confirmed findings.', owner);
    }
    if (value.outcome === 'fail' && !value.findings.length) {
      issue('missing-finding', path, 'Fail requires a grounded finding.', owner);
    }
    if (value.outcome === 'pass'
      && (value.scopeStatus !== 'complete' || !requiredComplete(expected.requiredFields))) {
      issue('unsupported-complete-pass', path, 'A whole-scope Pass requires every declared source to be complete.', owner);
    }
    if (value.outcome === 'pass' && !value.evidence.length) {
      issue('unsupported-pass', path, 'A clean findings list is not positive evidence for Pass.', owner);
    }
    if (!excluded && (value.scopeStatus !== 'complete' || !requiredComplete(expected.requiredFields))) {
      incomplete = true;
    }
    if (!excluded && value.scopeStatus === 'complete' && !requiredComplete(expected.requiredFields)) {
      issue('scope-overstatement', path, 'The assessment claims complete scope despite incomplete required sources.', owner);
    }
    if (input.unitKind === 'standard' && !expected.ruleId.startsWith('STD-') && value.findings.length > 1) {
      issue('instruction-finding-cardinality', path, 'Standard instruction criteria allow at most one combined finding.', owner);
    }
    evidenceIssues(value.evidence, expected.allowedFields, expected.allowedAbsenceFields, `${path}/evidence`, owner);
    const findingsSeen = new Set<string>();
    for (const [findingIndex, finding] of value.findings.entries()) {
      const findingPath = `${path}/findings/${findingIndex}`;
      if (!finding.fact.trim()) issue('blank-finding', findingPath, 'A finding must state the supported defect.', owner);
      evidenceIssues(finding.evidence, expected.allowedFields, expected.allowedAbsenceFields, `${findingPath}/evidence`, owner);
      if (input.unitKind === 'cross-skill' && ['XSK-01', 'XSK-02', 'XSK-03', 'XSK-05'].includes(expected.ruleId)) {
        const skillIds = new Set(finding.evidence
          .filter(item => expected.eligibleComponentIds.includes(item.componentId))
          .map(item => item.componentId));
        if (skillIds.size !== 2) {
          issue('cross-skill-pair', findingPath, 'A pair finding must identify exactly two eligible skills in its evidence.', owner);
        }
      }
      const signature = JSON.stringify([
        finding.fact,
        finding.evidence.map(evidence =>
          JSON.stringify([evidence.componentId, evidence.fieldPath, evidence.kind, evidence.quote])).sort(),
      ]);
      if (findingsSeen.has(signature)) issue('duplicate-finding', findingPath, 'The same fact/evidence is repeated.', owner);
      findingsSeen.add(signature);
      if (!finding.remediation) {
        issue('missing-remediation', findingPath,
          'Findings require all four grounded remediation fields.', owner);
      }
      if (finding.remediation
        && [finding.remediation.findingTitle, finding.remediation.whyItMatters,
          finding.remediation.makerAction, finding.remediation.acceptanceCheck].some(text => !text.trim())) {
        issue('blank-remediation', findingPath, 'Required remediation fields cannot be blank.', owner);
      }
      // Contract v4.1 section 2: whyItMatters states THIS agent's impact. Echoing the catalog's
      // generic rationale is a drift defect, but it is reported rather than rejected so a real,
      // evidence-backed finding is never discarded over wording alone.
      if (finding.remediation?.whyItMatters.trim()
        && finding.remediation.whyItMatters.trim().toLowerCase()
          === (validationRuleContract(expected.ruleId)?.why ?? '').trim().toLowerCase()) {
        warn('remediation-echoes-catalog', `${findingPath}/remediation/whyItMatters`,
          'whyItMatters repeats the catalog rationale instead of this agent-specific impact.', owner);
      }
    }
    for (const [observationIndex, observation] of value.observations.entries()) {
      evidenceIssues(observation.evidence, expected.allowedFields, expected.allowedAbsenceFields,
        `${path}/observations/${observationIndex}/evidence`, owner);
    }
    if (issues.length === start) assessments.push(value);
  }
  for (const expected of input.expectedAssessments) {
    if (!assessmentCounts.has(expected.assessmentKey)) {
      issue('missing-assessment', 'assessments', 'An expected assessment was not returned.', { assessmentKey: expected.assessmentKey });
    }
  }

  const recordCounts = keyCounts(raw.records, 'recordKey');
  const expectedRecords = new Map(input.expectedRecords.map(record => [record.recordKey, record]));
  for (const [index, value] of raw.records.entries()) {
    const path = `records/${index}`;
    if (!schema.record(value)) {
      issue('record-schema', path, 'The informational record violates the frozen schema.');
      continue;
    }
    const owner = { recordKey: value.recordKey };
    const start = issues.length;
    const expected = expectedRecords.get(value.recordKey);
    if (!expected || value.ruleId !== expected.ruleId || value.subjectId !== expected.subjectId) {
      issue('record-identity', path, 'The record is not an expected identity.', owner);
      continue;
    }
    if (recordCounts.get(value.recordKey) !== 1) issue('duplicate-record', path, 'A record key occurs more than once.', owner);
    if (!value.fact.trim()) issue('blank-record-fact', path, 'An informational record requires a fact.', owner);
    evidenceIssues(value.evidence, expected.allowedFields, [], `${path}/evidence`, owner);
    if (value.availability === 'complete') {
      if (!requiredComplete(expected.requiredFields) || !value.evidence.length) {
        issue('unsupported-complete-record', path, 'Complete informational records require complete, grounded source evidence.', owner);
      }
    } else {
      incomplete = true;
      if (!value.reason.trim()) issue('missing-record-reason', path, 'Incomplete records require a reason.', owner);
    }
    if (issues.length === start) records.push(value);
  }
  for (const expected of input.expectedRecords) {
    if (!recordCounts.has(expected.recordKey)) {
      issue('missing-record', 'records', 'An expected informational record was not returned.', { recordKey: expected.recordKey });
    }
  }
  if (raw.status === 'complete' && incomplete) {
    issue('unsupported-complete-unit', 'status', 'An unresolved applicable assessment or required source makes this unit partial.');
  }
  return finish(incomplete);
}
