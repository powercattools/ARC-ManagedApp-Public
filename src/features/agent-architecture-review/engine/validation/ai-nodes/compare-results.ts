import {
  fieldKey,
  type Assessment,
  type BaselineDisposition,
  type Evidence,
  type Finding,
  type NodeInput,
  type NodeKind,
  type Outcome,
  type RecordedBaseline,
  type ValidatedNodeResult,
  type ValidationIssue,
} from './contracts';

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;

export type LegacyDecision =
  | { readonly basis: 'explicit-outcome'; readonly outcome: Outcome }
  | { readonly basis: 'defect-findings'; readonly outcome: 'fail' }
  | { readonly basis: 'unknown' | 'unreported'; readonly outcome: null; readonly reason: string };

type AssessmentDetails = Omit<Assessment, 'assessmentKey' | 'ruleId' | 'subjectId' | 'outcome' | 'findings'>;

/**
 * Replayed legacy rows predate contract v4.1, so skill, standalone-skill and cross-skill snapshots
 * carry no node-authored remediation and reconstructing one would fabricate it. Scoped to historical
 * baselines only: live node output still requires Finding.remediation for every kind.
 */
export type LegacyFinding = Omit<Finding, 'remediation'> & { remediation?: Finding['remediation'] };

export interface LegacySnapshot {
  readonly raw: unknown;
  readonly decision: LegacyDecision;
  /** Only actual defect findings, never positive summaries, observations or dimension grades. */
  readonly findings: readonly Immutable<LegacyFinding>[];
  /** Supply only if these details were recorded, not reconstructed from a title or grade. */
  readonly details?: Immutable<AssessmentDetails>;
}

export interface LegacyRuleResult {
  /** Stable row/invocation/assessment locator, not componentId. Do not re-key one mixed finding into two records. */
  readonly legacyKey: string;
  readonly ruleId: string;
  /** Captured subject identity, normalized by an explicit adapter, never a display name. */
  readonly subjectId: string;
  readonly raw: LegacySnapshot;
  /** Null means the accepted/displayed legacy result was not recovered. */
  readonly accepted: LegacySnapshot | null;
}

export type LegacyMappingContext =
  | { readonly kind: 'standard-callable'; readonly population: 'tools' | 'connected-agents' | 'mixed'; readonly reference: string }
  | { readonly kind: 'instruction-role' | 'instruction-summary'; readonly reference: string }
  | { readonly kind: 'skill-contradiction' | 'skill-guardrails'; readonly sourceVersion: string; readonly reference: string };

export interface LegacyRuleMapping {
  readonly legacyKey: string;
  readonly ruleId: string;
  readonly subjectId: string;
  /** Context must identify the actual source contract/population, not just similar wording. */
  readonly context?: LegacyMappingContext;
}

export interface LegacyUnitBaseline extends Readonly<RecordedBaseline> {
  readonly unitKind?: NodeKind;
  readonly scopeHash?: string;
  readonly acceptedRaw: unknown;
  readonly results: readonly LegacyRuleResult[];
  readonly mappings: readonly LegacyRuleMapping[];
}

export interface UnitComparisonInput {
  readonly input: Immutable<NodeInput>;
  /** Hash of submitted evidence, not transport bytes containing new job/input IDs. */
  readonly sourceEvidenceHash: string;
  /** Hash of node/profile, subject population, applicability and declared evidence scope. */
  readonly scopeHash: string;
  readonly baseline: LegacyUnitBaseline | null;
  readonly candidate: {
    readonly raw: unknown;
    readonly validated: Immutable<ValidatedNodeResult> | null;
    readonly promptHash?: string;
    readonly schemaHash?: string;
    readonly model?: string;
  };
}

export type ComparisonChange =
  | 'same-conclusion'
  | 'wording-only'
  | 'explicit-outcome-change'
  | 'coverage-change'
  | 'changed-scope'
  | 'invalid-candidate'
  | 'missing-evidence'
  | 'unavailable-baseline';

export interface ComparisonDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly legacyKey?: string;
  readonly key?: string;
  readonly assessmentKey?: string;
}

export interface ComparisonRow {
  /** Collision-safe canonical rule/subject identity; titles and assessment-key spelling are not identity. */
  readonly key: string;
  readonly ruleId: string;
  readonly subjectId: string;
  readonly assessmentKeys: readonly string[];
  readonly baselineDisposition: BaselineDisposition;
  readonly legacy: {
    readonly state: 'reported' | 'unknown' | 'unreported' | 'unavailable';
    readonly outcome: Outcome | null;
    readonly reason: string;
    readonly record: LegacyRuleResult | null;
  };
  readonly candidate: {
    readonly state: 'accepted' | 'invalid' | 'missing';
    readonly outcome: Outcome | null;
    readonly assessment: Immutable<Assessment> | null;
    readonly issues: readonly Immutable<ValidationIssue>[];
  };
  readonly changes: readonly ComparisonChange[];
  readonly explanation: readonly string[];
}

export interface UnitComparisonReport {
  readonly unitId: string;
  readonly unitKind: NodeKind;
  readonly sourceEvidenceHash: string;
  readonly scopeHash: string;
  readonly baselineDisposition: BaselineDisposition;
  readonly baselineReasons: readonly string[];
  readonly baseline: LegacyUnitBaseline | null;
  readonly candidate: UnitComparisonInput['candidate'];
  readonly rows: readonly ComparisonRow[];
  readonly unmappedLegacy: readonly LegacyRuleResult[];
  readonly diagnostics: readonly ComparisonDiagnostic[];
  readonly counts: {
    readonly expectedAssessments: number;
    readonly uniqueRuleSubjects: number;
    readonly acceptedAssessments: number;
    readonly missingAssessments: number;
    readonly invalidAssessments: number;
  };
  readonly limitations: readonly string[];
}

const claimKey = (value: { ruleId: string; subjectId: string }) =>
  JSON.stringify([value.ruleId, value.subjectId]);
const present = (value: string | undefined) => Boolean(value?.trim());

function grouped<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const id = key(value);
    const group = groups.get(id);
    if (group) group.push(value);
    else groups.set(id, [value]);
  }
  return groups;
}

function disposition(request: UnitComparisonInput) {
  const { baseline, candidate } = request;
  const reasons = baseline ? [baseline.reason] : ['No recorded baseline was supplied.'];
  if (!baseline || baseline.disposition === 'missing') {
    return { value: 'missing' as const, reasons };
  }
  if (present(baseline.sourceEvidenceHash) && present(request.sourceEvidenceHash)
    && baseline.sourceEvidenceHash !== request.sourceEvidenceHash) reasons.push('Submitted source-evidence hashes differ.');
  if (present(baseline.scopeHash) && present(request.scopeHash)
    && baseline.scopeHash !== request.scopeHash) reasons.push('Declared evidence/population scope hashes differ.');
  if (baseline.unitKind && baseline.unitKind !== request.input.unitKind) reasons.push('Node profiles differ.');
  if (baseline.disposition === 'scope-mismatch' || reasons.length > 1) {
    return { value: 'scope-mismatch' as const, reasons };
  }
  const gaps = [
    ['baseline source evidence', baseline.sourceEvidenceHash], ['candidate source evidence', request.sourceEvidenceHash],
    ['baseline scope', baseline.scopeHash], ['candidate scope', request.scopeHash],
    ['baseline node profile', baseline.unitKind], ['baseline job/run', baseline.sourceJobId || baseline.sourceRunId],
    ['baseline prompt', baseline.promptHash], ['baseline schema', baseline.schemaHash], ['baseline model', baseline.model],
    ['candidate prompt', candidate.promptHash], ['candidate schema', candidate.schemaHash], ['candidate model', candidate.model],
  ].filter(([, value]) => !present(value)).map(([name]) => name);
  if (gaps.length) reasons.push(`Missing provenance: ${gaps.join(', ')}.`);
  if (baseline.disposition === 'historical-only' || gaps.length) {
    reasons.push('Historical context only; this is not a controlled prompt/model comparison.');
    return { value: 'historical-only' as const, reasons };
  }
  return { value: 'matched-recorded' as const, reasons };
}

function mappingProblem(source: LegacyRuleResult, mapping: LegacyRuleMapping): string | null {
  if (!present(source.legacyKey)) return 'A stable original legacy source locator is required.';
  if (source.subjectId !== mapping.subjectId) return 'The mapped subject differs from the captured subject identity.';
  const context = mapping.context;
  if (source.ruleId === 'STD-PATTERN-TOOL-ROUTING-GAP') {
    if (context?.kind !== 'standard-callable' || !present(context.reference) || context.population === 'mixed') {
      return 'The legacy callable rule needs an evidenced tool-only or connected-agent-only population; mixed findings cannot be split.';
    }
    const target = context.population === 'tools' ? 'STD-TOL-ROUTING-DESCRIPTION' : 'STD-CON-DELEGATION-DESCRIPTION';
    return mapping.ruleId === target ? null : 'The callable population does not match the proposed canonical rule.';
  }
  if (source.ruleId === 'INS-02'
    && (context?.kind !== 'instruction-role' || !present(context.reference))) {
    return 'INS-02 requires explicit role-check source context; a summary or unresolved collision is not a role assessment.';
  }
  if (source.ruleId === 'SKL-10'
    && (context?.kind !== 'skill-contradiction' || !present(context.reference) || !present(context.sourceVersion))) {
    return 'SKL-10 requires the recorded contradiction contract/version; unknown or legacy guardrail meanings remain unmapped.';
  }
  if (context && source.ruleId !== 'INS-02' && source.ruleId !== 'SKL-10') {
    return 'The supplied collision context does not belong to this legacy rule.';
  }
  return source.ruleId === mapping.ruleId ? null : 'No supported explicit canonical alias exists for this legacy rule.';
}

function snapshotProblem(snapshot: LegacySnapshot): string | null {
  const { decision, findings } = snapshot;
  if (!['explicit-outcome', 'defect-findings', 'unknown', 'unreported'].includes(decision.basis)) {
    return 'A numeric grade, default status or unsupported adapter basis is not a legacy quality decision.';
  }
  if (decision.basis === 'defect-findings' && (decision.outcome !== 'fail' || !findings.length)) {
    return 'A defect-findings decision requires an actual defect finding and can establish only Fail.';
  }
  if (decision.basis === 'explicit-outcome'
    && (!['pass', 'fail', 'not-assessed'].includes(decision.outcome)
      || (decision.outcome !== 'fail' && findings.length > 0))) {
    return 'The explicit legacy outcome is unsupported or conflicts with its defect findings.';
  }
  if ((decision.basis === 'unknown' || decision.basis === 'unreported') && decision.outcome !== null) {
    return 'Unknown/unreported legacy decisions cannot carry a quality outcome.';
  }
  return null;
}

function evidenceSignature(evidence: readonly Immutable<Evidence>[]): string[] {
  return evidence.map(item => JSON.stringify([item.componentId, item.fieldPath, item.kind, item.quote])).sort();
}

function findingSignature(finding: Immutable<LegacyFinding>, includeTitle: boolean): string {
  const remediation = finding.remediation;
  return JSON.stringify([
    finding.fact, evidenceSignature(finding.evidence),
    remediation ? [
      includeTitle ? remediation.findingTitle : null, remediation.whyItMatters,
      remediation.makerAction, remediation.acceptanceCheck, remediation.suggestedText ?? null,
    ] : null,
  ]);
}

function detailsSignature(details: Immutable<AssessmentDetails>): string {
  return JSON.stringify([
    details.scopeStatus, details.fact, details.reason, evidenceSignature(details.evidence),
    details.observations.map(item => [item.kind, item.fact, evidenceSignature(item.evidence)]),
  ]);
}

// Only a changed display title with identical structured reasoning/evidence is mechanically wording-only.
function titleOnlyChange(legacy: LegacySnapshot, candidate: Immutable<Assessment>): boolean {
  if (!legacy.details || detailsSignature(legacy.details) !== detailsSignature(candidate)) return false;
  const signature = (findings: readonly Immutable<LegacyFinding>[], titles: boolean) =>
    JSON.stringify(findings.map(finding => findingSignature(finding, titles)).sort());
  return signature(legacy.findings, false) === signature(candidate.findings, false)
    && signature(legacy.findings, true) !== signature(candidate.findings, true);
}

/**
 * Pure, descriptive comparison of already-frozen units; no parsing, I/O, scoring or semantic grading.
 * An adapter must preserve both legacy layers, extract only recorded explicit decisions or actual
 * defect findings, and supply a one-to-one source-locator/canonical-rule/subject map. Empty findings,
 * omitted notAssessed, default "complete", and numeric grades must be unknown/unreported, never Pass.
 * Collision contexts must cite the actual source contract/population. In particular, do not clone a
 * mixed callable vote, map an INS-02 summary, or guess a SKL-10 alias from a title. Stable XSK IDs can
 * map identically. Unresolved mappings are returned intact. Raw blobs are retained without inspection.
 * Child/flow Succeeded status does not supply missing resultjson. Recovered invocation output belongs
 * in the raw layer; it does not prove the accepted/displayed layer was persisted. Preserve competing
 * child records until explicit input/unit correlation resolves them, rather than choosing by componentId.
 * Validate the frozen NodeInput first; candidate.validated must come from validateNodeOutput for it.
 */
export function compareNodeResults(request: UnitComparisonInput): UnitComparisonReport {
  const { input, baseline, candidate } = request;
  const diagnostics: ComparisonDiagnostic[] = [];
  const diagnose = (code: string, message: string, owner: Omit<ComparisonDiagnostic, 'code' | 'message'> = {}) =>
    diagnostics.push({ code, message, ...owner });
  const baselineStatus = disposition(request);
  if (baselineStatus.value !== baseline?.disposition) {
    diagnose('baseline-reclassified', baselineStatus.reasons.join(' '));
  }
  const expected = grouped(input.expectedAssessments, claimKey);
  const expectedKeys = grouped(input.expectedAssessments, item => item.assessmentKey);
  for (const [key, group] of expected) {
    if (group.length > 1) diagnose('duplicate-expected-claim', 'Expected rule/subject is duplicated; no decision is selected.', { key });
  }
  for (const [assessmentKey, group] of expectedKeys) {
    if (group.length > 1) diagnose('duplicate-expected-key', 'Expected assessment key is ambiguous.', { assessmentKey });
  }

  const legacyResults = baseline?.results ?? [];
  const mappings = baseline?.mappings ?? [];
  const sources = grouped(legacyResults, item => item.legacyKey);
  const mappingSources = grouped(mappings, item => item.legacyKey);
  const mappingTargets = grouped(mappings, claimKey);
  const mapped = new Map<string, LegacyRuleResult>();
  const mappedSources = new Set<string>();
  const badAccepted = new Set<LegacySnapshot>();
  for (const [legacyKey, group] of sources) {
    if (group.length > 1) diagnose('duplicate-legacy-key', 'The legacy source locator occurs more than once.', { legacyKey });
    for (const result of group) {
      for (const [layer, snapshot] of [['raw', result.raw], ['accepted', result.accepted]] as const) {
        if (!snapshot) continue;
        const problem = snapshotProblem(snapshot);
        if (problem) {
          diagnose('invalid-legacy-decision', `${layer}: ${problem}`, { legacyKey });
          if (layer === 'accepted') badAccepted.add(snapshot);
        }
      }
    }
  }
  for (const mapping of mappings) {
    const key = claimKey(mapping);
    const owner = { key, legacyKey: mapping.legacyKey };
    const group = sources.get(mapping.legacyKey);
    let invalid = false;
    if (!group || group.length !== 1 || !expected.has(key)) {
      diagnose('foreign-or-ambiguous-legacy-mapping', 'Mapping must identify one recovered legacy record and an expected canonical rule/subject.', owner);
      invalid = true;
    }
    if (mappingSources.get(mapping.legacyKey)!.length !== 1 || mappingTargets.get(key)!.length !== 1) {
      diagnose('duplicate-legacy-mapping', 'A source or canonical target is mapped more than once; all competing mappings are rejected.', owner);
      invalid = true;
    }
    if (group?.length === 1) {
      const problem = mappingProblem(group[0], mapping);
      if (problem) {
        diagnose('unresolved-legacy-mapping', problem, owner);
        invalid = true;
      }
    }
    if (!invalid && group) {
      mapped.set(key, group[0]);
      mappedSources.add(mapping.legacyKey);
    }
  }
  const unmappedLegacy = legacyResults.filter(result => !mappedSources.has(result.legacyKey));
  for (const result of unmappedLegacy) {
    diagnose('unmapped-legacy-result', 'Preserved without a canonical comparison vote.', { legacyKey: result.legacyKey });
  }

  const validated = candidate.validated;
  const acceptedKeys = grouped(validated?.assessments ?? [], item => item.assessmentKey);
  const acceptedClaims = grouped(validated?.assessments ?? [], claimKey);
  const validCandidates = new Map<string, Immutable<Assessment>>();
  const badCandidateKeys = new Set<string>();
  const wrongResult = Boolean(validated && (validated.unitId !== input.unitId
    || validated.expectedAssessmentCount !== input.expectedAssessments.length));
  if (wrongResult) diagnose('candidate-unit-mismatch', 'Validated result does not describe this frozen unit/expected population.');
  for (const assessment of validated?.assessments ?? []) {
    const key = claimKey(assessment);
    const owner = { key, assessmentKey: assessment.assessmentKey };
    const targets = expectedKeys.get(assessment.assessmentKey);
    const duplicate = acceptedKeys.get(assessment.assessmentKey)!.length !== 1 || acceptedClaims.get(key)!.length !== 1;
    const foreign = targets?.length !== 1 || claimKey(targets[0]) !== key;
    const issueConflict = validated!.issues.some(issue => issue.assessmentKey === assessment.assessmentKey);
    if (duplicate || foreign || issueConflict) {
      diagnose(duplicate ? 'duplicate-candidate-assessment' : foreign ? 'foreign-candidate-assessment' : 'candidate-validation-conflict',
        'Only an unambiguous, expected, mechanically accepted assessment can supply a candidate outcome.', owner);
      badCandidateKeys.add(assessment.assessmentKey);
    } else if (!wrongResult) {
      validCandidates.set(key, assessment);
    }
  }
  const sourceFields = grouped(input.sources, fieldKey);
  const rows: ComparisonRow[] = [];
  for (const [key, group] of expected) {
    const first = group[0];
    const assessmentKeys = group.map(item => item.assessmentKey);
    const invalidExpected = group.length !== 1 || assessmentKeys.some(id => expectedKeys.get(id)!.length !== 1);
    const issues = validated?.issues.filter(issue => assessmentKeys.includes(issue.assessmentKey ?? '')
      || (!issue.assessmentKey && !issue.recordKey)) ?? [];
    const assessment = invalidExpected || wrongResult ? null : validCandidates.get(key) ?? null;
    const rejected = invalidExpected || wrongResult || assessmentKeys.some(id => badCandidateKeys.has(id));
    const state = assessment ? 'accepted'
      : rejected ? 'invalid'
        : !validated || issues.some(issue => issue.code === 'missing-assessment') ? 'missing' : 'invalid';
    const record = mapped.get(key) ?? null;
    const snapshot = record?.accepted;
    let legacy: ComparisonRow['legacy'];
    if (baselineStatus.value === 'missing') {
      legacy = { state: 'unavailable', outcome: null, record, reason: 'No recorded comparison baseline is available.' };
    } else if (!record) {
      const unresolved = mappingTargets.has(key) || legacyResults.some(item => claimKey(item) === key);
      legacy = {
        state: unresolved ? 'unknown' : 'unreported', outcome: null, record: null,
        reason: unresolved ? 'The legacy rule/subject mapping is unresolved.' : 'No legacy decision was reported for this canonical rule/subject.',
      };
    } else if (!snapshot || badAccepted.has(snapshot)) {
      legacy = { state: 'unknown', outcome: null, record, reason: 'Accepted/displayed legacy decisions are unavailable or inconsistent; raw findings are not a substitute.' };
    } else {
      const decision = snapshot.decision;
      legacy = decision.outcome === null
        ? { state: decision.basis, outcome: null, record, reason: decision.reason }
        : { state: 'reported', outcome: decision.outcome, record, reason: `Recorded legacy ${decision.basis}.` };
    }
    const changes: ComparisonChange[] = [];
    const explanation = [legacy.reason];
    if (baselineStatus.value === 'historical-only') explanation.push('Historical comparison only; no controlled prompt/model improvement is established.');
    if (baselineStatus.value === 'missing') changes.push('unavailable-baseline');
    const splitScope = record?.ruleId === 'STD-PATTERN-TOOL-ROUTING-GAP';
    if (baselineStatus.value === 'scope-mismatch' || splitScope) {
      changes.push('changed-scope');
      explanation.push(splitScope
        ? 'The legacy callable criterion has an intentional canonical population split; its historical parent is not a second vote.'
        : 'Different evidence or profile/population scope; outcomes are descriptive, not a prompt-only change.');
    }
    if (state !== 'accepted') {
      changes.push('invalid-candidate');
      explanation.push(`Candidate assessment is ${state}; raw output cannot supply a fallback Pass.`);
    }
    const missingEvidence = group.some(item => item.applicability.state !== 'not-applicable'
      && (item.applicability.state === 'not-assessed' || item.requiredFields.some(field => {
        const matches = sourceFields.get(fieldKey(field));
        return matches?.length !== 1 || matches[0].availability !== 'complete';
      })));
    if (missingEvidence) {
      changes.push('missing-evidence');
      explanation.push('Required evidence is missing, incomplete or ambiguously identified in the frozen input.');
    }
    if (assessment && baselineStatus.value !== 'missing' && baselineStatus.value !== 'scope-mismatch' && !splitScope) {
      if (legacy.outcome === null) {
        changes.push('coverage-change');
        explanation.push(assessment.outcome === 'not-assessed'
          ? 'V3 explicitly reports Not assessed; this is reporting coverage, not a completed assessment.'
          : 'V3 supplies an explicit assessment; unknown/unreported legacy coverage is not an old Pass.');
        if (record && !snapshot) changes.push('unavailable-baseline');
      } else if (legacy.outcome !== assessment.outcome) {
        changes.push('explicit-outcome-change');
        if (legacy.outcome === 'not-assessed' || assessment.outcome === 'not-assessed') changes.push('coverage-change');
        explanation.push(`Explicit accepted outcome changed from ${legacy.outcome} to ${assessment.outcome}; correctness is not adjudicated.`);
      } else if (baselineStatus.value === 'matched-recorded' && snapshot && titleOnlyChange(snapshot, assessment)) {
        changes.push('wording-only');
        explanation.push('Only finding display titles differ; structured facts, reasoning, remediation and evidence are identical.');
      } else {
        changes.push('same-conclusion');
        explanation.push('The explicit quality outcome is the same; this alone does not establish equivalent findings or wording.');
      }
    }
    rows.push({
      key, ruleId: first.ruleId, subjectId: first.subjectId, assessmentKeys,
      baselineDisposition: baselineStatus.value, legacy,
      candidate: { state, outcome: assessment?.outcome ?? null, assessment, issues },
      changes, explanation,
    });
  }
  return {
    unitId: input.unitId, unitKind: input.unitKind,
    sourceEvidenceHash: request.sourceEvidenceHash, scopeHash: request.scopeHash,
    baselineDisposition: baselineStatus.value, baselineReasons: baselineStatus.reasons,
    baseline, candidate, rows, unmappedLegacy, diagnostics,
    counts: {
      expectedAssessments: input.expectedAssessments.length, uniqueRuleSubjects: rows.length,
      acceptedAssessments: rows.filter(row => row.candidate.state === 'accepted').length,
      missingAssessments: rows.filter(row => row.candidate.state === 'missing').length,
      invalidAssessments: rows.filter(row => row.candidate.state === 'invalid').length,
    },
    limitations: [
      'Mechanical acceptance does not establish semantic correctness or improved accuracy.',
      'Historical, missing and scope-mismatched baselines cannot establish a controlled prompt improvement.',
      'No scores, dimension grades, weights or production outcomes are calculated.',
    ],
  };
}
