import { fieldKey, type BaselineDisposition, type Evidence, type FieldRef, type Finding, type NodeInput, type SourceField } from './contracts';
import type { LegacyDecision, LegacyFinding, LegacyMappingContext, LegacyRuleMapping, LegacyRuleResult, LegacySnapshot, LegacyUnitBaseline } from './compare-results';

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
type Population = 'tools' | 'connected-agents';

export interface LegacyStandardRule {
  readonly ruleId: string;
  readonly applicability: { readonly eligibleComponentIds: readonly string[] };
  readonly requiredEvidence: { readonly allowedFieldPaths: readonly string[]; readonly allowEmptyQuoteForAbsence: boolean };
}

export type LegacySourceContract =
  | {
    readonly kind: 'standard';
    readonly reference: string;
    readonly rules: readonly LegacyStandardRule[];
    readonly components: readonly { readonly componentId: string; readonly componentType: string }[];
  }
  | {
    readonly kind: 'copilot-instructions';
    readonly reference: string;
    readonly instructionField: Readonly<FieldRef>;
    /** The historical validator normalized case/whitespace. Never rewrite the recorded quote. */
    readonly grounding: 'exact' | 'legacy-normalized';
  }
  | {
    readonly kind: 'copilot-skill' | 'standalone-skill';
    readonly reference: string;
    readonly skillField: Readonly<FieldRef>;
    readonly resourceFields: readonly { readonly resourcePath: string; readonly field: Readonly<FieldRef> }[];
    readonly skill10?: {
      readonly meaning: 'contradiction' | 'guardrails';
      readonly sourceVersion: string;
      readonly reference: string;
    };
  }
  | {
    readonly kind: 'cross-skill';
    readonly reference: string;
    /** Exact recorded skill names resolved to captured source fields, not title-based aliases. */
    readonly skills: readonly { readonly name: string; readonly fields: readonly Readonly<FieldRef>[] }[];
  };

export interface LegacyAcceptedRule {
  readonly ruleId: string;
  readonly subjectId: string;
  /** Required for an accepted callable partition; a mixed parent cannot be copied into both. */
  readonly population?: Population;
  /** INS-02 accepted summaries are not role decisions; identify an actual accepted role element. */
  readonly context?: LegacyMappingContext;
  readonly snapshot: LegacySnapshot;
}

export interface LegacyRecordedNode {
  readonly identity: {
    readonly unitId: string;
    readonly subjectId: string;
    readonly inputLocator: string;
    readonly outputLocator: string;
    readonly sourceJobId: string;
    readonly sourceRunId: string;
    readonly actionName: string;
    readonly repetition: string;
  };
  readonly contract: LegacySourceContract;
  /** Readable fields from the recorded input, not freshly fetched or substituted candidate evidence. */
  readonly fields: readonly Readonly<SourceField>[];
  /** The original .io.json envelope; only outputs.outputs.body.structuredOutput is interpreted. */
  readonly output: unknown;
  readonly disposition: BaselineDisposition;
  readonly reason: string;
  readonly provenance: {
    readonly sourceEvidenceHash?: string;
    readonly scopeHash?: string;
    readonly promptHash?: string;
    readonly schemaHash?: string;
    readonly model?: string;
  };
  /**
   * Omit/null if unavailable. Supplying raw alone does not assert that any rule passed.
   * A saved "complete" status stays in this layer; it never supplies an omitted raw model status.
   */
  readonly accepted?: {
    readonly locator: string;
    readonly raw: unknown;
    readonly rules: readonly LegacyAcceptedRule[];
  } | null;
}

export interface LegacyBaselineRequest {
  readonly input: Immutable<NodeInput>;
  readonly sourceEvidenceHash: string;
  readonly scopeHash: string;
  readonly recorded: LegacyRecordedNode | null;
}

export interface LegacyBaselineDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly ruleId?: string;
}

export interface LegacyBaselineResult {
  readonly baseline: LegacyUnitBaseline;
  readonly structuredOutput: unknown;
  readonly diagnostics: readonly LegacyBaselineDiagnostic[];
  readonly unmappedAccepted: readonly LegacyAcceptedRule[];
}

const INSTRUCTION_RULES = {
  role: 'INS-02', tone: 'INS-03', boundaries: 'INS-04', ambiguity: 'INS-05', escalation: 'INS-06',
} as const;
const CALLABLE = 'STD-PATTERN-TOOL-ROUTING-GAP';
const CALLABLE_TARGETS = { tools: 'STD-TOL-ROUTING-DESCRIPTION', 'connected-agents': 'STD-CON-DELEGATION-DESCRIPTION' } as const;
const XSK_RULES = ['XSK-01', 'XSK-02', 'XSK-03', 'XSK-04', 'XSK-05', 'XSK-06'];
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const stringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(text);
const tuple = (ruleId: string, subjectId: string, population?: Population) => JSON.stringify([ruleId, subjectId, population ?? null]);
const unknownDecision = (reason: string): LegacyDecision => ({ basis: 'unknown', outcome: null, reason });
const unreportedDecision = (reason: string): LegacyDecision => ({ basis: 'unreported', outcome: null, reason });

function groups<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    const values = result.get(id);
    if (values) values.push(item);
    else result.set(id, [item]);
  }
  return result;
}

interface RuleProjection {
  ruleId: string;
  population?: Population;
  snapshot: LegacySnapshot;
  context?: LegacyMappingContext;
  targetId: string;
  mappable: boolean;
  suppliedFailure: boolean;
}

/**
 * Adapt one explicitly correlated recorded invocation without executing ART, parsing message prose,
 * assigning grades or assuming persistence. The caller supplies original source fields, source/target
 * hashes, pinned contract context and any independently recovered accepted-rule snapshots.
 * Raw projections are conservative source-format/grounding checks, NOT a replay of ART's validators.
 * In particular, accepted output is never manufactured from a well-formed raw node response.
 * Recovering a baseline does not execute a candidate. Until a candidate runs, comparison callers
 * must retain candidate.validated: null rather than synthesize a not-assessed AI assessment.
 */
export function buildLegacyUnitBaseline(request: LegacyBaselineRequest): LegacyBaselineResult {
  const diagnostics: LegacyBaselineDiagnostic[] = [];
  const issue = (code: string, path: string, message: string, ruleId?: string) =>
    diagnostics.push({ code, path, message, ...(ruleId ? { ruleId } : {}) });
  const source = request.recorded;
  if (!source) {
    issue('missing-recorded-node', '', 'No recorded node exists for this profile.');
    return {
      baseline: { disposition: 'missing', reason: 'No recorded node exists for this profile.', raw: null, acceptedRaw: null, results: [], mappings: [] },
      structuredOutput: undefined, diagnostics, unmappedAccepted: [],
    };
  }
  const { identity, contract, provenance } = source;
  const envelope = object(source.output);
  const body = object(object(object(envelope?.outputs)?.outputs)?.body);
  const structuredOutput = body && Object.hasOwn(body, 'structuredOutput') ? body.structuredOutput : undefined;
  const structured = object(structuredOutput);
  const expected = groups(request.input.expectedAssessments, item => tuple(item.ruleId, item.subjectId));
  let identityValid = true;
  if (Object.values(identity).some(value => !text(value)) || !text(contract.reference)
    || identity.unitId !== request.input.unitId
    || request.input.expectedAssessments.some(item => item.subjectId !== identity.subjectId)) {
    issue('unresolved-node-identity', 'identity', 'A complete input/invocation locator and exact target unit/subject binding are required.');
    identityValid = false;
  }
  for (const [key, value] of [['runId', identity.sourceRunId], ['actionName', identity.actionName], ['repetition', identity.repetition]] as const) {
    if (envelope?.[key] !== value) {
      issue('invocation-identity-mismatch', key, 'The envelope is not the explicitly resolved recorded invocation.');
      identityValid = false;
    }
  }
  for (const entries of expected.values()) {
    if (entries.length !== 1) {
      issue('duplicate-target-claim', 'input.expectedAssessments', 'Duplicate canonical rule/subject bindings cannot choose a legacy vote.', entries[0].ruleId);
      identityValid = false;
    }
  }
  if (!structured) issue(structuredOutput == null ? 'missing-structured-output' : 'invalid-structured-output',
    'outputs.outputs.body.structuredOutput', 'No structured result object is available. Succeeded status, message text and activities are not a substitute.');
  if (envelope?.status !== 'Succeeded') issue('invocation-status', 'status', 'Invocation success was not recorded; execution status is not a rule outcome.');
  if (structured && contract.kind !== 'copilot-instructions' && !Object.hasOwn(structured, 'status')) {
    issue('unreported-output-status', 'structuredOutput.status', 'The old node omitted status; no default complete status is assigned.');
  }
  if (structured && Object.hasOwn(structured, 'status') && !['complete', 'partial'].includes(String(structured.status))) {
    issue('invalid-output-status', 'structuredOutput.status', 'The reported status is not a supported legacy status.');
  }

  let disposition: BaselineDisposition = source.disposition;
  const reasons = [source.reason];
  const differentScope = contract.kind !== request.input.unitKind
    || (text(provenance.sourceEvidenceHash) && text(request.sourceEvidenceHash) && provenance.sourceEvidenceHash !== request.sourceEvidenceHash)
    || (text(provenance.scopeHash) && text(request.scopeHash) && provenance.scopeHash !== request.scopeHash);
  const missingProvenance = [provenance.sourceEvidenceHash, provenance.scopeHash, provenance.promptHash,
    provenance.schemaHash, provenance.model, request.sourceEvidenceHash, request.scopeHash].some(value => !text(value));
  if (!identityValid || !structured) {
    disposition = 'missing';
    reasons.push(!identityValid ? 'Recorded invocation identity is unresolved.' : 'The invocation contains no usable structured output.');
  } else if (differentScope || disposition === 'scope-mismatch') {
    disposition = 'scope-mismatch';
    reasons.push('Recorded evidence, source scope or node profile differs from the candidate.');
  } else if (disposition !== 'missing' && (missingProvenance || envelope?.status !== 'Succeeded')) {
    disposition = 'historical-only';
    reasons.push('Input/version provenance or execution evidence is incomplete; historical context only.');
  }
  if (disposition !== source.disposition) issue('baseline-reclassified', 'disposition', reasons.join(' '));

  const fields = groups(source.fields, fieldKey);
  for (const [key, values] of fields) {
    if (values.length > 1) issue('duplicate-source-field', `fields/${key}`, 'Duplicate recorded source identities are not resolved by first/last write.');
  }
  function field(ref: Readonly<FieldRef>): Readonly<SourceField> | null {
    const matches = fields.get(fieldKey(ref));
    return matches?.length === 1 ? matches[0] : null;
  }
  function quote(ref: Readonly<FieldRef>, value: string, path: string, allowAbsence = false): Evidence | null {
    const captured = field(ref);
    if (!captured || captured.availability === 'unavailable'
      || (value === '' ? !allowAbsence || captured.availability !== 'complete' : !captured.content.includes(value))) {
      issue('unresolved-legacy-evidence', path, 'Evidence must identify one readable recorded field and an exact quote, or authorized complete-field absence.');
      return null;
    }
    return { componentId: ref.componentId, fieldPath: ref.fieldPath, kind: value === '' ? 'reviewed-field' : 'quote', quote: value };
  }
  const projections: RuleProjection[] = [];
  const project = (ruleId: string, snapshot: LegacySnapshot, options: Partial<Omit<RuleProjection, 'ruleId' | 'snapshot'>> = {}) =>
    projections.push({ ruleId, snapshot, targetId: ruleId, mappable: true, suppliedFailure: false, ...options });
  const absent = (raw: unknown, reason = 'No explicit legacy rule decision was reported.'): LegacySnapshot =>
    ({ raw, decision: unreportedDecision(reason), findings: [] });
  const unresolved = (raw: unknown, reason: string): LegacySnapshot =>
    ({ raw, decision: unknownDecision(reason), findings: [] });
  const usable = identityValid && structured !== null;

  if (usable && contract.kind === 'copilot-instructions') {
    const elements = Array.isArray(structured.elements) ? structured.elements : [];
    const elementGroups = groups(elements, item => String(object(item)?.key));
    const keys = Object.keys(INSTRUCTION_RULES);
    const citations = structured.citationIds;
    const exactKeys = elements.length === keys.length && keys.every(key => elementGroups.get(key)?.length === 1)
      && elements.every(item => text(object(item)?.key) && keys.includes(String(object(item)?.key)));
    const validCitation = Array.isArray(citations) && citations.length === 1
      && object(citations[0])?.id === 'ms-authoring-instructions';
    if (!exactKeys) issue('instruction-element-keys', 'structuredOutput.elements', 'Exactly five unique role/tone/boundaries/ambiguity/escalation keys are required.');
    if (!validCitation) issue('instruction-citation', 'structuredOutput.citationIds', 'The exact historical instruction-authoring citation is required.');
    const instructions = field(contract.instructionField);
    for (const [key, ruleId] of Object.entries(INSTRUCTION_RULES)) {
      const values = elementGroups.get(key) ?? [];
      const element = values.length === 1 ? object(values[0]) : null;
      let snapshot = unresolved(values, 'The instruction element is missing, duplicated, malformed or ungrounded.');
      if (exactKeys && validCitation && element && typeof element.present === 'boolean' && typeof element.evidence === 'string'
        && instructions && instructions.availability !== 'unavailable') {
        const normalize = (value: string) => contract.grounding === 'legacy-normalized' ? value.replace(/\s+/g, ' ').trim().toLowerCase() : value;
        const grounded = element.present
          ? text(element.evidence) && normalize(instructions.content).includes(normalize(element.evidence))
          : element.evidence.trim() === '' && instructions.availability === 'complete';
        if (grounded) snapshot = {
          raw: element, decision: { basis: 'explicit-outcome', outcome: element.present ? 'pass' : 'fail' }, findings: [],
        };
      }
      if (snapshot.decision.outcome === null) issue('invalid-instruction-element', `structuredOutput.elements/${key}`, 'No semantic decision is accepted from this malformed or ungrounded element.', ruleId);
      project(ruleId, snapshot, {
        suppliedFailure: exactKeys && validCitation && element?.present === false,
        ...(ruleId === 'INS-02' ? { context: { kind: 'instruction-role' as const, reference: contract.reference } } : {}),
      });
    }
  } else if (usable) {
    const rawFindings = Array.isArray(structured.findings) ? structured.findings : [];
    const hasFindings = Array.isArray(structured.findings);
    if (!hasFindings) issue('missing-findings-array', 'structuredOutput.findings', 'An omitted/malformed findings array is not an empty successful evaluation.');
    const findingsByRule = groups(rawFindings, finding => String(object(finding)?.ruleId));
    const notAssessed = contract.kind === 'standard' && Array.isArray(structured.notAssessed) ? structured.notAssessed : [];
    if (contract.kind === 'standard' && !Array.isArray(structured.notAssessed)) {
      issue('omitted-not-assessed', 'structuredOutput.notAssessed', 'The old node omitted notAssessed; no rule Pass is inferred.');
    }
    const exclusionsByRule = groups(notAssessed, entry => String(object(entry)?.ruleId));
    const standardRules = contract.kind === 'standard' ? groups(contract.rules, rule => rule.ruleId) : new Map<string, LegacyStandardRule[]>();
    const knownIds = contract.kind === 'standard' ? [...standardRules.keys()]
      : contract.kind === 'cross-skill' ? XSK_RULES : ['SKL-09', 'SKL-10'];
    for (const id of new Set([...findingsByRule.keys(), ...exclusionsByRule.keys()])) {
      if (!knownIds.includes(id)) {
        issue('foreign-legacy-rule', 'structuredOutput', 'The output rule is not in the supplied legacy node contract; titles and dimension rationales cannot alias it.', id);
        project(id, unresolved([...(findingsByRule.get(id) ?? []), ...(exclusionsByRule.get(id) ?? [])], 'Unregistered legacy rule.'), { mappable: false });
      }
    }
    const componentGroups = contract.kind === 'standard' ? groups(contract.components, item => item.componentId) : null;
    const resourceGroups = contract.kind === 'copilot-skill' || contract.kind === 'standalone-skill'
      ? groups(contract.resourceFields, item => item.resourcePath) : null;
    const skillGroups = contract.kind === 'cross-skill' ? groups(contract.skills, item => item.name) : null;
    for (const ruleId of knownIds) {
      const rows = findingsByRule.get(ruleId) ?? [];
      const excluded = exclusionsByRule.get(ruleId) ?? [];
      const raw = { findings: rows, notAssessed: excluded };
      let invalid = !hasFindings;
      const details: Array<{ finding: LegacyFinding; population?: Population; raw: unknown }> = [];
      const signatures = new Set<string>();
      for (const row of rows) {
        const path = `structuredOutput.findings/${rawFindings.indexOf(row)}`;
        const item = object(row);
        let finding: LegacyFinding | null = null;
        let population: Population | undefined;
        if (item && contract.kind === 'standard') {
          const rules = standardRules.get(ruleId);
          const rule = rules?.length === 1 ? rules[0] : null;
          const remediationKeys = ['findingTitle', 'whyItMatters', 'makerAction', 'acceptanceCheck'] as const;
          if (rule && stringArray(item.affectedComponentIds) && item.affectedComponentIds.length > 0
            && new Set(item.affectedComponentIds).size === item.affectedComponentIds.length
            && item.affectedComponentIds.every(id => rule.applicability.eligibleComponentIds.includes(id))
            && Array.isArray(item.evidence) && item.evidence.length > 0 && remediationKeys.every(key => text(item[key]))
            && (item.suggestedText === undefined || text(item.suggestedText))) {
            const evidence = item.evidence.map((value, index) => {
              const part = object(value);
              return part && text(part.componentId) && text(part.fieldPath) && typeof part.quote === 'string'
                && item.affectedComponentIds && (item.affectedComponentIds as string[]).includes(part.componentId)
                && rule.requiredEvidence.allowedFieldPaths.includes(part.fieldPath)
                ? quote({ componentId: part.componentId, fieldPath: part.fieldPath }, part.quote, `${path}/evidence/${index}`, rule.requiredEvidence.allowEmptyQuoteForAbsence)
                : null;
            });
            if (evidence.every((entry): entry is Evidence => entry !== null)) {
              finding = {
                fact: item.findingTitle as string, evidence,
                remediation: {
                  findingTitle: item.findingTitle as string, whyItMatters: item.whyItMatters as string,
                  makerAction: item.makerAction as string, acceptanceCheck: item.acceptanceCheck as string,
                  ...(typeof item.suggestedText === 'string' ? { suggestedText: item.suggestedText } : {}),
                },
              };
              if (ruleId === CALLABLE) {
                const types = item.affectedComponentIds.map(id => {
                  const matches = componentGroups?.get(id);
                  return matches?.length === 1 ? matches[0].componentType : undefined;
                });
                if (types.every(type => type === 'tool')) population = 'tools';
                else if (types.every(type => type === 'connected-agent')) population = 'connected-agents';
                else {
                  issue('mixed-callable-finding', path, 'One mixed/unknown callable finding cannot be split into two legacy votes.', ruleId);
                  finding = null;
                }
              }
            }
          }
        } else if (item && text(item.evidence) && ['critical', 'high', 'medium', 'low', 'info'].includes(String(item.severity))) {
          if (item.severity === 'info') {
            issue('neutral-legacy-observation', path, 'An informational observation does not establish a rule failure.', ruleId);
          } else if ((contract.kind === 'copilot-skill' || contract.kind === 'standalone-skill')
            && typeof item.resourcePath === 'string' && ['high', 'medium', 'low'].includes(String(item.confidence))) {
            const resources = resourceGroups?.get(item.resourcePath);
            const ref = item.resourcePath === '' ? contract.skillField : resources?.length === 1 ? resources[0].field : null;
            const evidence = ref ? quote(ref, item.evidence, `${path}/evidence`) : null;
            if (evidence) finding = { fact: item.evidence, evidence: [evidence] };
          } else if (contract.kind === 'cross-skill' && stringArray(item.skills) && item.skills.length > 0
            && new Set(item.skills).size === item.skills.length && stringArray(item.referenceIds) && item.referenceIds.length > 0) {
            const named = item.skills.map(name => skillGroups?.get(name));
            const pair = ['XSK-01', 'XSK-02', 'XSK-03', 'XSK-05'].includes(ruleId);
            if (named.every(matches => matches?.length === 1) && (!pair || item.skills.length >= 2)) {
              const refs = named.flatMap(matches => matches![0].fields);
              const uniqueRefs = groups(refs, fieldKey);
              const matching = [...uniqueRefs.values()].map(values => values[0]).filter(ref => {
                const captured = field(ref);
                return captured && captured.availability !== 'unavailable' && captured.content.includes(item.evidence as string);
              });
              if (matching.length === 1) {
                const evidence = quote(matching[0], item.evidence, `${path}/evidence`);
                if (evidence) finding = { fact: item.evidence, evidence: [evidence] };
              } else issue('ambiguous-cross-skill-evidence', path, 'The quote does not identify exactly one recorded field in the explicitly named skill population.', ruleId);
            }
          }
        }
        if (!finding) {
          invalid = true;
          issue('invalid-legacy-finding', path, 'The finding is malformed, neutral, outside recorded scope or lacks unambiguous grounded evidence.', ruleId);
        } else {
          const participants = contract.kind === 'cross-skill' && stringArray(item?.skills) ? [...item.skills].sort()
            : contract.kind === 'standard' && stringArray(item?.affectedComponentIds) ? [...item.affectedComponentIds].sort() : [];
          const signature = JSON.stringify([population ?? null, participants, finding.fact,
            finding.evidence.map(part => JSON.stringify([part.componentId, part.fieldPath, part.kind, part.quote])).sort()]);
          if (signatures.has(signature)) {
            invalid = true;
            issue('duplicate-legacy-finding', path, 'Repeated equivalent findings are diagnosed, not resolved by first/last write.', ruleId);
          }
          signatures.add(signature);
          details.push({ finding, population, raw: row });
        }
      }
      if (excluded.length > 1 || (excluded.length > 0 && rows.length > 0)) {
        invalid = true;
        issue('legacy-outcome-conflict', 'structuredOutput.notAssessed', 'Repeated notAssessed or simultaneous defect/notAssessed records cannot choose a conclusion.', ruleId);
      }
      const reason = excluded.length === 1 ? object(excluded[0])?.reason : undefined;
      if (excluded.length === 1 && !text(reason)) {
        invalid = true;
        issue('invalid-not-assessed', 'structuredOutput.notAssessed', 'Explicit notAssessed requires a nonempty recorded reason.', ruleId);
      }
      if (contract.kind === 'standard' && standardRules.get(ruleId)?.length !== 1) {
        invalid = true;
        issue('duplicate-legacy-contract-rule', 'contract.rules', 'The recorded rule contract is ambiguous.', ruleId);
      }
      let context: LegacyMappingContext | undefined;
      let mappable = true;
      if (ruleId === 'SKL-10' && (contract.kind === 'copilot-skill' || contract.kind === 'standalone-skill')) {
        const pinned = contract.skill10;
        if (!pinned || pinned.meaning !== 'contradiction' || !text(pinned.sourceVersion) || !text(pinned.reference)) {
          mappable = false;
          issue('unresolved-skl10-contract', 'contract.skill10', 'SKL-10 needs the pinned contradiction meaning; guardrails and unknown versions are not aliased.', ruleId);
        } else context = { kind: 'skill-contradiction', sourceVersion: pinned.sourceVersion, reference: pinned.reference };
      }
      if (ruleId === CALLABLE) {
        if (!invalid && details.length > 0) {
          for (const population of ['tools', 'connected-agents'] as const) {
            const partition = details.filter(detail => detail.population === population);
            if (partition.length) project(ruleId, {
              raw: partition.map(detail => detail.raw), decision: { basis: 'defect-findings', outcome: 'fail' },
              findings: partition.map(detail => detail.finding),
            }, { population, suppliedFailure: true, targetId: CALLABLE_TARGETS[population], context: { kind: 'standard-callable', population, reference: contract.reference } });
          }
        } else {
          project(ruleId, invalid ? unresolved(raw, 'The callable population cannot be partitioned safely.')
            : text(reason) ? { raw, decision: { basis: 'explicit-outcome', outcome: 'not-assessed' }, findings: [] }
              : absent(raw), { mappable: false, suppliedFailure: rows.length > 0 });
          if (invalid || excluded.length) issue('unresolved-callable-population', 'structuredOutput', 'The legacy parent outcome is retained without copying it to either new population.', ruleId);
        }
        continue;
      }
      const snapshot: LegacySnapshot = invalid ? unresolved(raw, 'Legacy rule output is malformed, conflicting or ungrounded.')
        : details.length ? { raw, decision: { basis: 'defect-findings', outcome: 'fail' }, findings: details.map(detail => detail.finding) }
          : text(reason) ? { raw, decision: { basis: 'explicit-outcome', outcome: 'not-assessed' }, findings: [] }
            : absent(raw);
      project(ruleId, snapshot, { context, mappable, suppliedFailure: rows.length > 0 });
    }
    if (contract.kind === 'copilot-skill' || contract.kind === 'standalone-skill') {
      if ('dimensions' in structured) issue('unscored-legacy-dimensions', 'structuredOutput.dimensions', 'Numeric grades and rationales remain raw data, not rule outcomes.');
      if (['missingCapabilities', 'contradictions', 'resourcePurposeAlignment', 'operationalAssumptions'].some(key => Array.isArray(structured[key]) && (structured[key] as unknown[]).length)) {
        issue('unmapped-legacy-side-output', 'structuredOutput', 'Checklist/rationale side outputs without supplied rule findings are preserved, not promoted into SKL rule failures.');
      }
    }
  }

  const represented = new Set(projections.map(projection => tuple(projection.targetId, identity.subjectId)));
  for (const entries of expected.values()) {
    const target = entries[0];
    if (represented.has(tuple(target.ruleId, target.subjectId))) continue;
    const mixed = Object.values(CALLABLE_TARGETS).includes(target.ruleId as typeof CALLABLE_TARGETS[Population])
      && projections.some(projection => projection.ruleId === CALLABLE && !projection.mappable
        && projection.snapshot.decision.basis !== 'unreported');
    project(target.ruleId, !usable || mixed ? unresolved(structuredOutput, mixed ? 'The old mixed callable outcome cannot be allocated.' : 'No attributable structured node output is available.')
      : absent(structuredOutput, 'This canonical rule has no explicit decision in the recorded legacy node output.'));
  }

  const accepted = source.accepted;
  const acceptedGroups = groups(accepted?.rules ?? [], rule => tuple(rule.ruleId, rule.subjectId, rule.population));
  const usedAccepted = new Set<LegacyAcceptedRule>();
  const results: LegacyRuleResult[] = [];
  const mappings: LegacyRuleMapping[] = [];
  for (const projection of projections) {
    const key = tuple(projection.ruleId, identity.subjectId, projection.population);
    const legacyKey = JSON.stringify([identity.outputLocator, key]);
    const candidates = acceptedGroups.get(key) ?? [];
    let acceptedSnapshot: LegacySnapshot | null = null;
    if (accepted && text(accepted.locator)) {
      if (candidates.length > 1) {
        issue('duplicate-accepted-rule', 'accepted.rules', 'Competing accepted rule snapshots are preserved without choosing one.', projection.ruleId);
        acceptedSnapshot = unresolved(candidates.map(candidate => candidate.snapshot.raw), 'Accepted rule snapshots are duplicated.');
      } else if (candidates.length === 1) {
        const candidate = candidates[0];
        const decision = candidate.snapshot.decision;
        const outcome = decision.outcome;
        const roleContext = projection.ruleId !== 'INS-02'
          || (candidate.context?.kind === 'instruction-role' && text(candidate.context.reference));
        const skillContext = projection.ruleId !== 'SKL-10' || !candidate.context
          || (candidate.context.kind === 'skill-contradiction' && projection.context?.kind === 'skill-contradiction'
            && candidate.context.sourceVersion === projection.context.sourceVersion && text(candidate.context.reference));
        const supported = roleContext && skillContext && (outcome === null
          ? ['unknown', 'unreported'].includes(decision.basis)
          : ['pass', 'fail', 'not-assessed'].includes(outcome)
            && (outcome === 'fail' ? projection.suppliedFailure : outcome === projection.snapshot.decision.outcome)
            && (outcome === 'fail' || candidate.snapshot.findings.length === 0)
            && (decision.basis === 'explicit-outcome' || (decision.basis === 'defect-findings' && outcome === 'fail' && candidate.snapshot.findings.length > 0)));
        if (!supported) {
          issue('unsupported-accepted-decision', 'accepted.rules', 'Accepted metadata cannot manufacture a rule outcome absent from the recorded structured decision.', projection.ruleId);
          acceptedSnapshot = unresolved(candidate.snapshot.raw, 'The supplied accepted decision is not supported by the recorded rule output.');
        } else {
          acceptedSnapshot = candidate.snapshot;
          usedAccepted.add(candidate);
          if (outcome !== null && outcome !== projection.snapshot.decision.outcome) {
            issue('accepted-differs-from-raw-projection', 'accepted.rules',
              'The independently supplied legacy accepted result differs from this adapter’s stricter raw checks. Preserve the historical result; do not call it a new acceptance.', projection.ruleId);
          }
        }
      } else {
        acceptedSnapshot = projection.snapshot.decision.basis === 'unreported'
          ? absent(accepted.raw, 'No explicit accepted/displayed rule decision was supplied.')
          : unresolved(accepted.raw, 'The accepted/displayed view supplied no decision for this raw rule; a dropped finding is not Pass.');
      }
    } else if (accepted) issue('unresolved-accepted-locator', 'accepted.locator', 'The accepted/displayed artifact needs its own explicit locator.');
    results.push({
      legacyKey, ruleId: projection.ruleId, subjectId: identity.subjectId, raw: projection.snapshot, accepted: acceptedSnapshot,
    });
    if (usable && projection.mappable && expected.has(tuple(projection.targetId, identity.subjectId))) {
      mappings.push({
        legacyKey, ruleId: projection.targetId, subjectId: identity.subjectId,
        ...(projection.context ? { context: projection.context } : {}),
      });
    }
  }
  const unmappedAccepted = (accepted?.rules ?? []).filter(rule => !usedAccepted.has(rule));
  for (const rule of unmappedAccepted) issue('unmapped-accepted-rule', 'accepted.rules', 'Accepted rule identity/partition is foreign, duplicated or unsupported; its supplied snapshot is retained separately.', rule.ruleId);
  return {
    baseline: {
      disposition, reason: reasons.join(' '), unitKind: contract.kind,
      sourceJobId: identity.sourceJobId, sourceRunId: identity.sourceRunId, ...provenance,
      raw: source.output, acceptedRaw: accepted ? accepted.raw : null, results, mappings,
    },
    structuredOutput, diagnostics, unmappedAccepted,
  };
}
