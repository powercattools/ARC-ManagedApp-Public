export const VALIDATION_CATALOG_VERSION = 'arc2-ai-rules-v1' as const;
export const VALIDATION_SCHEMA_VERSION = 3 as const;
export const ARC2_VALIDATION_FLOW_ID = '782fff99-546e-4114-82d4-47627e5683b0';

export type NodeKind =
  | 'standard'
  | 'copilot-instructions'
  | 'copilot-skill'
  | 'cross-skill'
  | 'standalone-skill';

export type Outcome = 'pass' | 'fail' | 'not-assessed';
export type Availability = 'complete' | 'partial' | 'unavailable';

export interface FieldRef {
  componentId: string;
  fieldPath: string;
}

export interface SourceField extends FieldRef {
  availability: Availability;
  content: string;
  reason?: string;
}

export interface Evidence extends FieldRef {
  kind: 'quote' | 'reviewed-field';
  quote: string;
}

export type NodeRuleCategory = 'configuration' | 'routing' | 'instructions';

export interface RuleContract {
  title: string;
  category: NodeRuleCategory;
  question: string;
  passWhen: string[];
  failWhen: string[];
  notApplicableWhen: string[];
  why: string;
  fix: string;
}

/**
 * The rule contract as the agent nodes read it. Every field name here is fixed by the live node
 * prompts, so this shape is a wire contract: rename nothing without re-authoring those prompts.
 * `title`, `passWhen`, `why` and `fix` are deliberately absent. No prompt names them, and keeping
 * the catalog `why`/`fix` away from the node is what stops it echoing them back as the
 * per-instance `whyItMatters`/`makerAction`.
 */
export interface NodeRule {
  ruleId: string;
  name: string;
  category: NodeRuleCategory;
  evaluationQuestion: string;
  failWhen: string[];
  rejectWhen: string[];
  applicability: {
    status: 'applicable' | 'not-applicable' | 'not-assessed';
    eligibleComponentIds: string[];
  };
  requiredEvidence: {
    allowedFieldPaths: string[];
    allowEmptyQuoteForAbsence: boolean;
  };
}

export interface DeterministicAssessment {
  outcome: Outcome;
  fact: string;
  evidence: Evidence[];
}

export interface ExpectedAssessment {
  assessmentKey: string;
  ruleId: string;
  subjectId: string;
  execution: 'ai';
  applicability: {
    state: 'applicable' | 'not-applicable' | 'not-assessed';
    reason: string;
  };
  eligibleComponentIds: string[];
  allowedFields: FieldRef[];
  allowedAbsenceFields: FieldRef[];
  requiredFields: FieldRef[];
  deterministicAssessment?: DeterministicAssessment;
}

export interface ExpectedRecord {
  recordKey: string;
  ruleId: string;
  subjectId: string;
  allowedFields: FieldRef[];
  requiredFields: FieldRef[];
}

export interface UnitIdentity {
  schemaVersion: typeof VALIDATION_SCHEMA_VERSION;
  catalogVersion: typeof VALIDATION_CATALOG_VERSION;
  jobId: string;
  correlationId: string;
  unitId: string;
  inputId: string;
}

export interface NodeInput extends UnitIdentity {
  unitKind: NodeKind;
  context?: {
    agentId: string;
    agentName: string;
    scope: string;
    purpose?: string;
    orchestrationMode?: string;
    reviewLimits?: string[];
    components?: Array<{ componentId: string; name: string; componentType: string }>;
    artifact?: { kind: 'skill'; binding: 'unbound' | 'bound'; sourceSkillId: string };
  };
  rules: NodeRule[];
  expectedAssessments: ExpectedAssessment[];
  expectedRecords: ExpectedRecord[];
  sources: SourceField[];
}

/** Required host coverage metadata is not authored material and must never be allowed quotation evidence. */
export function isRequiredScopeMetadata(input: NodeInput, expected: ExpectedAssessment, field: FieldRef): boolean {
  return input.unitKind === 'standard' && field.componentId === input.context?.agentId
    && field.fieldPath === `$scope.${expected.ruleId}.population`;
}

export interface Remediation {
  findingTitle: string;
  whyItMatters: string;
  makerAction: string;
  acceptanceCheck: string;
  suggestedText?: string;
}

export interface Finding {
  fact: string;
  evidence: Evidence[];
  remediation: Remediation;
}

export interface Assessment {
  assessmentKey: string;
  ruleId: string;
  subjectId: string;
  outcome: Outcome;
  scopeStatus: Availability;
  fact: string;
  reason: string;
  evidence: Evidence[];
  findings: Finding[];
  observations: Array<{ kind: string; fact: string; evidence: Evidence[] }>;
}

export interface InformationalRecord {
  recordKey: string;
  ruleId: string;
  subjectId: string;
  availability: Availability;
  fact: string;
  reason: string;
  evidence: Evidence[];
}

export interface NodeOutput extends UnitIdentity {
  status: 'complete' | 'partial';
  assessments: Assessment[];
  records: InformationalRecord[];
}

export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
  assessmentKey?: string;
  recordKey?: string;
}

/** Bind these predicates to the frozen node-specific JSON schema, not a permissive legacy parser. */
export interface NodeSchemaGuards {
  output: (value: unknown) => value is NodeOutput;
  assessment: (value: unknown) => value is Assessment;
  record: (value: unknown) => value is InformationalRecord;
}

export interface ValidationProfile {
  kind: NodeKind;
  rules: ReadonlyMap<string, { execution: ExpectedAssessment['execution']; rule: RuleContract }>;
  recordIds: ReadonlySet<string>;
  subjectIds: ReadonlySet<string>;
}

export interface ValidatedNodeResult {
  unitId: string;
  /** Mechanical acceptance only; evidence relevance and semantic correctness require separate review. */
  accepted: boolean;
  coverage: 'complete' | 'partial';
  expectedAssessmentCount: number;
  assessments: Assessment[];
  records: InformationalRecord[];
  issues: ValidationIssue[];
  /** Nonblocking quality signals. These never affect `accepted`; they are reported, not enforced. */
  warnings: ValidationIssue[];
}

export type BaselineDisposition =
  | 'matched-recorded'
  | 'historical-only'
  | 'missing'
  | 'scope-mismatch';

export interface RecordedBaseline {
  disposition: BaselineDisposition;
  reason: string;
  sourceJobId?: string;
  sourceRunId?: string;
  sourceEvidenceHash?: string;
  promptHash?: string;
  schemaHash?: string;
  model?: string;
  raw: unknown;
}

export interface ValidationCase {
  caseId: string;
  sourceAgentId: string;
  sourceName: string;
  sourceEvidenceHash: string;
  jobId: string;
  correlationId: string;
  harness: 'Standard' | 'Copilot' | 'Skill';
  jobKind: 'StandardReview' | 'StandardSkillBundle' | 'ArtifactBundle';
  units: NodeInput[];
  baseline: RecordedBaseline;
}

export interface ReplayInput {
  schemaVersion: typeof VALIDATION_SCHEMA_VERSION;
  reviewContract: {
    consumer: 'arc2';
    contractVersion: typeof VALIDATION_SCHEMA_VERSION;
    catalogVersion: typeof VALIDATION_CATALOG_VERSION;
    scoringPolicyVersion: 'arc2-unified-v3';
  };
  harness: ValidationCase['harness'];
  jobKind: ValidationCase['jobKind'];
  review: {
    correlationId: string;
    botId: string;
    botName: string;
    sourceEnvironment: string;
  };
  standardReview?: { reviewUnits: NodeInput[] };
  copilotReview?: {
    instructionUnit: NodeInput;
    skillUnits: NodeInput[];
    crossSkillUnit: NodeInput;
  };
  artifactReview?: { portionUnits: NodeInput[] };
}

export function fieldKey(field: FieldRef): string {
  return JSON.stringify([field.componentId, field.fieldPath]);
}
