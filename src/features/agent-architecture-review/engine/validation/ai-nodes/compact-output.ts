import {
  fieldKey,
  isRequiredScopeMetadata,
  VALIDATION_CATALOG_VERSION,
  VALIDATION_SCHEMA_VERSION,
  type Assessment,
  type Availability,
  type Evidence,
  type ExpectedAssessment,
  type Finding,
  type NodeInput,
  type NodeSchemaGuards,
  type ValidationIssue,
} from './contracts';
import { validateNodeOutput } from './validate-output';

export interface ExceptionOutput {
  responseContract: 'arc2-exceptions-v1';
  unitId: string;
  inputId: string;
  processedAllExpectedRules: boolean;
  failures: Array<{ assessmentKey: string; scopeStatus: Availability; findings: Finding[] }>;
  notAssessed: Array<{ assessmentKey: string; scopeStatus: Availability; reason: string; evidence: Evidence[] }>;
}

/** Bind nonmutating guards to the compact schema and the pinned historical node schema. */
export interface ExceptionSchemaGuards {
  output: (raw: unknown) => raw is ExceptionOutput;
  canonical: NodeSchemaGuards;
}

export interface NormalizedExceptionAssessment extends Assessment {
  decisionBasis:
    | 'reported-failure'
    | 'reported-not-assessed'
    | 'inferred-from-complete-exceptions'
    | 'host-excluded'
    | 'host-unavailable';
  completionReference?: {
    responseContract: ExceptionOutput['responseContract'];
    unitId: string;
    inputId: string;
    processedAllExpectedRules: true;
  };
}

export interface ExceptionValidationResult {
  unitId: string;
  accepted: boolean;
  coverage: 'complete' | 'partial';
  /** A validated acknowledgement, not a claim that every criterion could be assessed. */
  processingComplete: boolean;
  expectedAssessmentCount: number;
  submittedAssessmentCount: number;
  assessments: NormalizedExceptionAssessment[];
  issues: ValidationIssue[];
  /** Nonblocking quality signals. These never affect `accepted`; they are reported, not enforced. */
  warnings: ValidationIssue[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const exactFields = (value: unknown, fields: string[]): value is Record<string, unknown> =>
  isObject(value) && Object.keys(value).length === fields.length
    && fields.every(field => Object.hasOwn(value, field));
const inferredFact = 'No failure was reported for this criterion in the completed unit.';

function keyCounts(values: unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (isObject(value) && typeof value.assessmentKey === 'string') {
      counts.set(value.assessmentKey, (counts.get(value.assessmentKey) ?? 0) + 1);
    }
  }
  return counts;
}

// The shipped node schemas still require `hybridResolution` on every assessment, because the live
// flow's contract has not been updated yet. The TS contract no longer models the field, so every
// host-built canonical assessment carries it through this constant to stay wire-valid. Delete this
// once flow 782's structuredOutputSchema and the node-package schemas drop the field.
const WIRE_HYBRID = { hybridResolution: '' } as Partial<Assessment>;

function emptyAssessment(expected: ExpectedAssessment): Assessment {
  return {
    assessmentKey: expected.assessmentKey, ruleId: expected.ruleId, subjectId: expected.subjectId,
    outcome: 'not-assessed', scopeStatus: 'unavailable', fact: '', reason: '',
    evidence: [], findings: [], observations: [], ...WIRE_HYBRID,
  };
}

interface Entry {
  expected: ExpectedAssessment;
  value: Record<string, unknown>;
  path: string;
}

/**
 * Normalize only this frozen unit. The caller must first run validateNodeInput with its
 * pinned profile; this gate checks transport, evidence and omission safety, not the catalog.
 */
export function normalizeExceptionOutput(
  input: NodeInput,
  raw: unknown,
  guards: ExceptionSchemaGuards,
): ExceptionValidationResult {
  const issues: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const blockedKeys = new Set<string>();
  const decisions = new Map<string, NormalizedExceptionAssessment>();
  const sources = new Map(input.sources.map(source => [fieldKey(source), source]));
  const expectedByKey = new Map(input.expectedAssessments.map(expected => [expected.assessmentKey, expected]));
  const issue = (code: string, path: string, message: string, assessmentKey?: string) => {
    issues.push({ code, path, message, ...(assessmentKey === undefined ? {} : { assessmentKey }) });
    if (assessmentKey !== undefined) blockedKeys.add(assessmentKey);
  };
  const requiredComplete = (expected: ExpectedAssessment) =>
    (expected.applicability.state !== 'applicable' || expected.requiredFields.length > 0)
      && expected.requiredFields.every(field => sources.get(fieldKey(field))?.availability === 'complete');
  const finish = (processingComplete = false): ExceptionValidationResult => {
    const assessments = input.expectedAssessments.map((expected): NormalizedExceptionAssessment => {
      const reported = decisions.get(expected.assessmentKey);
      if (reported) return reported;
      const excluded = expected.applicability.state === 'not-applicable';
      const diagnostic = issues.find(item => item.assessmentKey === expected.assessmentKey);
      const reason = expected.applicability.state !== 'applicable' ? expected.applicability.reason
        : `The host could not establish a decision: ${diagnostic?.message
          ?? 'complete, valid exception processing was not confirmed.'}`;
      return {
        ...emptyAssessment(expected), fact: reason, reason,
        scopeStatus: excluded && requiredComplete(expected) ? 'complete' : 'unavailable',
        decisionBasis: excluded ? 'host-excluded' : 'host-unavailable',
      };
    });
    const accepted = processingComplete && issues.length === 0;
    const complete = accepted && assessments.every((assessment, index) =>
      assessment.decisionBasis === 'host-excluded'
        || (assessment.outcome !== 'not-assessed' && assessment.scopeStatus === 'complete'
          && requiredComplete(input.expectedAssessments[index])));
    return {
      unitId: input.unitId, accepted, processingComplete,
      coverage: complete ? 'complete' : 'partial',
      expectedAssessmentCount: input.expectedAssessments.length,
      submittedAssessmentCount: input.expectedAssessments.filter(item => item.applicability.state === 'applicable').length,
      assessments, issues, warnings,
    };
  };

  if (input.schemaVersion !== VALIDATION_SCHEMA_VERSION || input.catalogVersion !== VALIDATION_CATALOG_VERSION) {
    issue('input-contract', '', 'The input must use the pinned canonical contract.');
  }
  if (input.expectedRecords.length) {
    issue('unsupported-expected-records', 'expectedRecords', 'This compact checkpoint does not request informational records.');
  }
  if (sources.size !== input.sources.length) {
    issue('ambiguous-input-source', 'sources', 'Duplicate source identities cannot be resolved by choosing one.');
  }
  const claims = new Set<string>();
  const keys = new Set<string>();
  for (const [index, expected] of input.expectedAssessments.entries()) {
    const path = `expectedAssessments/${index}`;
    const claim = JSON.stringify([expected.ruleId, expected.subjectId]);
    if (!expected.assessmentKey.trim() || keys.has(expected.assessmentKey) || claims.has(claim)) {
      issue('duplicate-expected-assessment', path, 'Expected keys and rule/subject claims must be nonempty and unique.', expected.assessmentKey);
    }
    keys.add(expected.assessmentKey);
    claims.add(claim);
    const allowed = new Set(expected.allowedFields.map(fieldKey));
    if (expected.allowedFields.some(field => !sources.has(fieldKey(field)))
      || expected.allowedFields.some(field => isRequiredScopeMetadata(input, expected, field))
      || expected.requiredFields.some(field => !sources.has(fieldKey(field))
        || (!allowed.has(fieldKey(field)) && !isRequiredScopeMetadata(input, expected, field)))
      || expected.allowedAbsenceFields.some(field => !allowed.has(fieldKey(field)))
      || (expected.applicability.state === 'applicable' && !expected.requiredFields.length)) {
      issue('invalid-input-scope', path, 'Each applicable criterion needs declared, permitted source identities and required scope.', expected.assessmentKey);
    }
    const eligible = new Set(expected.eligibleComponentIds);
    if (eligible.size !== expected.eligibleComponentIds.length
      || (input.unitKind === 'standard' && expected.allowedFields.some(field => !eligible.has(field.componentId)))) {
      issue('invalid-eligible-population', path, 'The declared eligible population does not authorize this source scope.', expected.assessmentKey);
    }
    if (expected.deterministicAssessment) {
      issue('unexpected-deterministic-owner', path, 'An AI criterion does not carry a deterministic decision.', expected.assessmentKey);
    }
  }
  if (issues.length) return finish();

  if (!isObject(raw)) {
    issue('invalid-output', '', 'The node returned no compact JSON object; prose is not a decision contract.');
    return finish();
  }
  if (raw.responseContract !== 'arc2-exceptions-v1') {
    issue('response-contract', 'responseContract', 'Only arc2-exceptions-v1 is supported by this normalizer.');
  }
  for (const key of ['unitId', 'inputId'] as const) {
    if (raw[key] !== input[key]) issue('identity-mismatch', key, `${key} does not match the frozen unit.`);
  }
  if (issues.length) return finish();
  if (!guards.output(raw)) {
    issue('output-schema', '', 'The raw output violates the compact exception schema.');
  }
  const acknowledged = raw.processedAllExpectedRules === true;
  if (typeof raw.processedAllExpectedRules !== 'boolean') {
    issue('missing-processing-acknowledgement', 'processedAllExpectedRules', 'An explicit boolean processing acknowledgement is required.');
  } else if (!acknowledged) {
    issue('incomplete-processing', 'processedAllExpectedRules', 'The node did not acknowledge processing every submitted applicable criterion.');
  }
  if (!Array.isArray(raw.failures) || !Array.isArray(raw.notAssessed)) {
    return finish();
  }

  const exceptionCounts = keyCounts([...raw.failures, ...raw.notAssessed]);
  function indexEntries(values: unknown[], collection: string, fields: string[], counts: Map<string, number>) {
    const entries = new Map<string, Entry>();
    for (const [index, value] of values.entries()) {
      const path = `${collection}/${index}`;
      const key = isObject(value) && typeof value.assessmentKey === 'string' ? value.assessmentKey : undefined;
      const expected = key === undefined ? undefined : expectedByKey.get(key);
      if (!exactFields(value, fields)) {
        issue('exception-schema', path, 'The record must contain exactly its declared compact fields.', key);
      } else if (!expected) {
        issue('assessment-identity', path, 'The key is outside the frozen expected work set.', key);
      } else if (expected.applicability.state !== 'applicable') {
        issue('host-only-assessment', path, 'Host dispositions are not submitted AI work.', key);
      } else if (counts.get(expected.assessmentKey) !== 1) {
        issue('duplicate-exception', path, 'Repeated or cross-listed keys are rejected, not resolved by first/last write.', key);
      } else {
        entries.set(expected.assessmentKey, { expected, value, path });
      }
    }
    return entries;
  }
  const failures = indexEntries(raw.failures, 'failures',
    ['assessmentKey', 'scopeStatus', 'findings'], exceptionCounts);
  const notAssessed = indexEntries(raw.notAssessed, 'notAssessed',
    ['assessmentKey', 'scopeStatus', 'reason', 'evidence'], exceptionCounts);

  function validateCanonical(expected: ExpectedAssessment, candidate: Record<string, unknown>, path: string) {
    // This is a host-built subset status, never a substitute for the compact acknowledgement.
    const status = candidate.outcome !== 'not-assessed' && candidate.scopeStatus === 'complete'
      && requiredComplete(expected) ? 'complete' : 'partial';
    const result = validateNodeOutput({ ...input, expectedAssessments: [expected], expectedRecords: [] }, {
      schemaVersion: input.schemaVersion, catalogVersion: input.catalogVersion,
      jobId: input.jobId, correlationId: input.correlationId, unitId: input.unitId, inputId: input.inputId,
      status, assessments: [candidate], records: [],
    }, guards.canonical);
    const compactPath = (problem: ValidationIssue) => {
      const suffix = problem.path.replace(/^assessments\/0/, '');
      return `${path}${suffix ? `/${suffix.replace(/^\//, '')}` : ''}`;
    };
    for (const problem of result.issues) {
      issue(problem.code, compactPath(problem), problem.message, expected.assessmentKey);
    }
    for (const problem of result.warnings) {
      warnings.push({ ...problem, path: compactPath(problem), assessmentKey: expected.assessmentKey });
    }
    return result.accepted ? result.assessments[0] : undefined;
  }

  for (const [collection, entries] of [['failures', failures], ['notAssessed', notAssessed]] as const) {
    for (const [key, { expected, value, path }] of entries) {
      if (blockedKeys.has(key)) continue;
      const failed = collection === 'failures';
      const firstFinding = Array.isArray(value.findings) ? value.findings[0] : undefined;
      const assessment = validateCanonical(expected, {
        ...emptyAssessment(expected), outcome: failed ? 'fail' : 'not-assessed',
        scopeStatus: value.scopeStatus,
        fact: failed ? (isObject(firstFinding) ? firstFinding.fact : '') : value.reason,
        reason: failed ? '' : value.reason,
        findings: failed ? value.findings : [],
        evidence: failed ? [] : value.evidence,
      }, path);
      if (assessment) {
        decisions.set(key, {
          ...structuredClone(assessment), decisionBasis: failed ? 'reported-failure' : 'reported-not-assessed',
        });
      }
    }
  }

  if (acknowledged) {
    for (const expected of input.expectedAssessments) {
      const key = expected.assessmentKey;
      if (expected.applicability.state !== 'applicable' || exceptionCounts.has(key)) continue;
      if (!requiredComplete(expected)) {
        issue('incomplete-omitted-scope', 'failures', 'An omitted criterion cannot become Pass while required source scope is incomplete.', key);
      }
    }
  }

  const processingComplete = acknowledged && issues.length === 0;
  if (processingComplete) {
    for (const expected of input.expectedAssessments) {
      if (expected.applicability.state !== 'applicable' || exceptionCounts.has(expected.assessmentKey)) continue;
      decisions.set(expected.assessmentKey, {
        ...emptyAssessment(expected), outcome: 'pass', scopeStatus: 'complete', fact: inferredFact,
        decisionBasis: 'inferred-from-complete-exceptions',
        completionReference: {
          responseContract: 'arc2-exceptions-v1', unitId: input.unitId, inputId: input.inputId,
          processedAllExpectedRules: true,
        },
      });
    }
  }
  return finish(processingComplete);
}
