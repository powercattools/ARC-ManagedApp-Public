import type { UnifiedRuleAssessment } from './art-ports';
import type {
  AI_REVIEW_POLICY_VERSION, AiReviewDimension, AiReviewGroup, AiReviewHarness, AiReviewSeverity,
} from './ai-review-catalog';
import type {
  DeterministicAssessment, Evidence, ExpectedAssessment, NodeInput, ValidationIssue,
} from '../validation/ai-nodes/contracts';
import type { ExceptionValidationResult, NormalizedExceptionAssessment } from '../validation/ai-nodes/compact-output';
import type { ProductionReviewRequest } from '../ai-workflow/request';
import type { AiWorkflowParent, UnitReceipt } from '../ai-workflow/receipt';

export interface AiEvaluationSignals {
  availability: 'complete' | 'partial' | 'unavailable';
  reason: string;
  hasUsableSet: boolean | null;
  hasCases: boolean | null;
  capabilityCoverageRatio: number | null;
  hasMultiTurnCoverage: boolean | null;
  expectedResponseRequirementSatisfied: boolean | null;
}

/** A native execution ledger, not an adapter from legacy artifact grades or finding absence. */
export interface ArtifactDeterministicAssessment extends Omit<UnifiedRuleAssessment, 'harness'> {
  harness: 'skill';
  scoringGroup: AiReviewDimension | null;
  catalogReference: string;
}
export type AiDeterministicAssessment = UnifiedRuleAssessment | ArtifactDeterministicAssessment;

export interface AiReviewUnit {
  input: NodeInput;
  receipt?: UnitReceipt;
  validation?: ExceptionValidationResult;
  issues?: readonly ValidationIssue[];
}

export interface AiProviderDecision {
  unitId: string;
  inputId: string;
  accepted: boolean;
  unitAccepted: boolean;
  processingComplete: boolean;
  expected: ExpectedAssessment;
  assessment?: NormalizedExceptionAssessment;
  reason: string;
}

export type AiReviewEvidence = UnifiedRuleAssessment['evidence'][number] & { kind?: Evidence['kind'] };
export interface AiReviewFinding {
  assessmentKey: string;
  ruleId: string;
  subjectId: string;
  fact: string;
  evidence: readonly AiReviewEvidence[];
  remediation?: NormalizedExceptionAssessment['findings'][number]['remediation'];
}

export interface AiReviewAssessment {
  kind: 'check';
  assessmentKey: string;
  scoreOwnerKey: string;
  ruleId: string;
  subjectId: string;
  title: string;
  question?: string;
  fact: string;
  why: string;
  fix: string;
  tags: readonly string[];
  severity: AiReviewSeverity;
  catalogWeight: 0 | 0.5 | 1;
  scoringGroup: AiReviewGroup | null;
  outcome: 'pass' | 'fail' | 'not-assessed';
  applicability: ExpectedAssessment['applicability'];
  decisionSource: 'ai' | 'deterministic' | 'deterministic-fallback' | 'host';
  decisionBasis: NormalizedExceptionAssessment['decisionBasis'] | 'deterministic-outcome' | 'deterministic-fallback';
  reason: string;
  resolution: string;
  incomplete: boolean;
  aiCoverage: 'not-required' | 'complete' | 'partial' | 'excluded';
  evidence: readonly AiReviewEvidence[];
  findings: readonly AiReviewFinding[];
  providers: {
    ai: readonly AiProviderDecision[];
    deterministic: readonly AiDeterministicAssessment[];
    declaredDeterministic: readonly DeterministicAssessment[];
  };
}

export interface AiReviewRecord {
  kind: 'record';
  ruleId: string;
  subjectId: string;
  title: string;
  fact: string;
  why: string;
  fix: string;
  severity: 'info';
  catalogWeight: 0;
  decisionSource: 'deterministic';
  evidence: readonly AiReviewEvidence[];
  provider: AiDeterministicAssessment;
}

export interface AiMergeIssue { code: string; message: string; path?: string; assessmentKey?: string; unitId?: string }
export interface AiWorkflowCoverageInput {
  parent: Pick<AiWorkflowParent, 'jobId' | 'state' | 'inputSha256' | 'executionId' | 'markerState'>;
  issues: readonly ValidationIssue[];
  transportComplete: boolean;
  reviewComplete: boolean;
}

/** Structural view of the parent's loaded snapshot; there is deliberately no backend score field. */
export interface AiWorkflowReviewSnapshot extends AiWorkflowCoverageInput {
  request: ProductionReviewRequest;
  units: readonly AiReviewUnit[];
}
export type AiWorkflowSourceBinding = {
  status: 'frozen-host-review';
  capturedAt: string;
  sourceFingerprint: string;
  sourcePolicyVersion: string;
} | {
  status: 'missing';
  reason: string;
};
export interface AiReviewCoverage {
  expected: number;
  completed: number;
  excluded: number;
  pending: number;
  ratio: number | null;
  complete: boolean;
}
export interface MergedAiReview {
  policyVersion: typeof AI_REVIEW_POLICY_VERSION;
  harness: AiReviewHarness;
  subjectId: string;
  assessments: readonly AiReviewAssessment[];
  records: readonly AiReviewRecord[];
  issues: readonly AiMergeIssue[];
  /** Workflow scoring inputs come only from the native ledger in the saved request. */
  frozenScoring?: { evaluation?: AiEvaluationSignals };
  coverage: {
    ai: AiReviewCoverage;
    manifestComplete: boolean;
    deterministic: { complete: boolean; reason: string };
    workflow?: {
      jobId: string;
      parentState: AiWorkflowCoverageInput['parent']['state'];
      transportComplete: boolean;
      reviewComplete: boolean;
    };
    sourceBinding?: AiWorkflowSourceBinding;
    incomplete: boolean;
  };
}

export interface MergeAiReviewInput {
  harness: AiReviewHarness;
  subjectId: string;
  deterministicAssessments: readonly AiDeterministicAssessment[];
  units: readonly AiReviewUnit[];
  deterministicCoverage?: { complete: boolean; reason: string };
  /** Production callers pass the loaded snapshot, so transport/parent issues cannot disappear at this boundary. */
  workflow?: AiWorkflowCoverageInput;
}

export type AiWorkflowLedgerContext = Pick<MergeAiReviewInput,
  'deterministicAssessments' | 'deterministicCoverage'>;
