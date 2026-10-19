import { ARC2_QUEUED_STATUS } from '../dispatch/ai-workflow-review-job';
import { ReviewHarness, ReviewJobStatus, corpusKindToJobKind } from '../scoring/art-ports';
import {
  normalizeExceptionOutput,
  type ExceptionValidationResult,
  type NormalizedExceptionAssessment,
} from '../validation/ai-nodes/compact-output';
import type { ValidationIssue } from '../validation/ai-nodes/contracts';
import { productionExceptionGuards } from '../validation/ai-nodes/production-guards';
import {
  MAX_REVIEW_ATTEMPTS, RECEIPT_CONTRACT, isObject, nonempty, parseProductionRequest, productionUnits, requireCondition,
  type ProductionReviewRequest, type ProductionUnit,
} from './request';
import { canonicalBytes, sha256Bytes } from './provenance';
import { parseExecutionMarker } from './execution-marker';

export interface UnitReceipt {
  contract: typeof RECEIPT_CONTRACT;
  jobId: string;
  unitId: string;
  inputId: string;
  unitKind: ProductionUnit['unitKind'];
  resultId: string;
  componentIndex: number;
  state: 'succeeded' | 'failed';
  attemptCount: number;
  /** ARC2 claim correlation, not a Power Automate platform run name. */
  flowRunId: string;
  inputSha256: string;
  output: unknown;
  error: { code: string; message: string } | null;
}

export interface AiWorkflowParent {
  jobId: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed';
  message: string;
  error: string;
  modifiedOn?: string;
  executionId?: string;
  inputSha256?: string;
  markerState?: AiWorkflowParent['state'];
}

export interface AiWorkflowUnitResult {
  input: ProductionUnit;
  receipt?: UnitReceipt;
  validation: ExceptionValidationResult;
  issues: ValidationIssue[];
  diagnostics?: string;
}

export interface AiWorkflowSnapshot {
  request: ProductionReviewRequest;
  parent: AiWorkflowParent;
  units: AiWorkflowUnitResult[];
  assessments: NormalizedExceptionAssessment[];
  issues: ValidationIssue[];
  /** Terminal transport receipts persisted, regardless of whether their judgments are usable. */
  transportComplete: boolean;
  /** Only evidence-validated, fully covered reviews are complete. An explicit Not assessed is partial. */
  reviewComplete: boolean;
}

function optionalText(value: unknown, field: string): string {
  requireCondition(value == null || typeof value === 'string', `${field} is not text.`);
  return value ?? '';
}

export function parseWorkflowParent(raw: unknown, request: ProductionReviewRequest): AiWorkflowParent {
  requireCondition(isObject(raw), 'The ARC2 review parent is missing.');
  const jobId = request.execution.jobId;
  requireCondition(raw.cat_agentreviewjobid === jobId && raw.cat_botid === `arc2:${jobId}`
    && raw.cat_correlationid === request.review.correlationId
    && raw.cat_componentcount === request.execution.expectedUnitCount
    && raw.cat_harness === ReviewHarness[request.harness]
    && raw.cat_jobkind === corpusKindToJobKind(request.jobKind),
  'The review parent does not match this ARC2 request identity, route, or unit population.');
  let state: AiWorkflowParent['state'];
  switch (raw.cat_jobstatus) {
    case ARC2_QUEUED_STATUS: state = 'queued'; break;
    case ReviewJobStatus.Running: state = 'running'; break;
    case ReviewJobStatus.Succeeded: state = 'succeeded'; break;
    case ReviewJobStatus.Failed: state = 'failed'; break;
    default: throw new Error('The ARC2 parent has an unsupported status; ART queue status is never an ARC2 submission.');
  }
  const modifiedOn = optionalText(raw.modifiedon, 'modifiedon');
  const lastStatus = optionalText(raw.cat_laststatus, 'cat_laststatus');
  const marker = parseExecutionMarker(lastStatus);
  return {
    jobId, state, message: marker ? `${marker.state}${marker.progress ? ` - ${marker.progress}` : ''}` : lastStatus,
    error: optionalText(raw.cat_errormessage, 'cat_errormessage'),
    ...(modifiedOn ? { modifiedOn } : {}),
    ...(marker ? {
      markerState: marker.state, inputSha256: marker.inputSha256,
      ...(marker.executionId ? { executionId: marker.executionId } : {}),
    } : {}),
  };
}

function parseReceipt(raw: unknown, input: ProductionUnit, parent: AiWorkflowParent, inputSha256: string): UnitReceipt {
  const fields = [
    'contract', 'jobId', 'unitId', 'inputId', 'unitKind', 'resultId',
    'componentIndex', 'state', 'attemptCount', 'flowRunId', 'inputSha256', 'output', 'error',
  ];
  requireCondition(isObject(raw) && fields.every(field => Object.hasOwn(raw, field))
    && Object.keys(raw).every(field => fields.includes(field)), 'The persisted result has no supported receipt envelope.');
  requireCondition(raw.contract === RECEIPT_CONTRACT && raw.jobId === parent.jobId
    && raw.unitId === input.unitId && raw.inputId === input.inputId
    && raw.unitKind === input.unitKind && raw.resultId === input.resultId
    && raw.componentIndex === input.componentIndex, 'The persisted receipt belongs to a different reserved input.');
  requireCondition((raw.state === 'succeeded' || raw.state === 'failed')
    && typeof raw.attemptCount === 'number' && Number.isSafeInteger(raw.attemptCount) && raw.attemptCount >= 1
    && raw.attemptCount <= MAX_REVIEW_ATTEMPTS && nonempty(raw.flowRunId, 200)
    && raw.flowRunId === parent.executionId && raw.inputSha256 === inputSha256,
  'The persisted receipt has invalid attempt, execution-owner or input-byte provenance.');
  let error: UnitReceipt['error'] = null;
  if (raw.state === 'failed') {
    requireCondition(isObject(raw.error) && Object.keys(raw.error).length === 2
      && nonempty(raw.error.code, 200) && nonempty(raw.error.message, 10000)
      && raw.output === null, 'A failed receipt must explain its failure and cannot carry successful output.');
    error = { code: raw.error.code, message: raw.error.message };
  } else {
    requireCondition(raw.error === null, 'A successful receipt cannot also report a transport error.');
  }
  return {
    contract: RECEIPT_CONTRACT, jobId: parent.jobId, unitId: input.unitId, inputId: input.inputId,
    unitKind: input.unitKind, resultId: input.resultId, componentIndex: input.componentIndex,
    state: raw.state, attemptCount: raw.attemptCount, flowRunId: raw.flowRunId, inputSha256, output: raw.output, error,
  };
}

function decodeReceipt(json: unknown): unknown {
  requireCondition(typeof json === 'string' && json.length > 0, 'The result row has no receipt JSON.');
  try {
    return JSON.parse(json);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error('The persisted receipt is not valid JSON.');
  }
}

/** Never chooses the newest conflicting row. Only the preallocated row/input pair may vote. */
export async function normalizeWorkflowResults(
  untrustedRequest: ProductionReviewRequest,
  rawParent: unknown,
  rows: readonly Record<string, unknown>[],
): Promise<AiWorkflowSnapshot> {
  const request = parseProductionRequest(structuredClone(untrustedRequest));
  const parent = parseWorkflowParent(rawParent, request);
  const frozenRows = structuredClone(rows);
  const inputSha256 = await sha256Bytes(canonicalBytes(request));
  const inputs = productionUnits(request);
  const issues: ValidationIssue[] = [];
  if (parent.inputSha256 !== inputSha256 || parent.markerState !== parent.state) {
    issues.push({
      code: 'input-provenance-mismatch', path: 'parent',
      message: 'The current frozen request does not match the execution handoff digest/state.',
    });
  }
  if (parent.state !== 'queued' && !parent.executionId) issues.push({
    code: 'missing-execution-owner', path: 'parent',
    message: 'The parent does not retain an explicit ARC2 execution owner.',
  });
  const bindingInvalid = issues.length > 0;
  const rowsByResult = new Map<string, Record<string, unknown>[]>();
  const blocked = new Set<string>();
  for (const [index, row] of frozenRows.entries()) {
    const declared = inputs.find(input => row.cat_componentid === input.unitId);
    const reserved = inputs.find(input => row.cat_agentreviewjobitemid === input.resultId);
    if (!reserved || row._cat_jobid_value !== parent.jobId || reserved !== declared
      || row.cat_componentindex !== reserved.componentIndex
      || row.cat_correlationid !== request.review.correlationId) {
      issues.push({
        code: 'foreign-result-row', path: `rows/${index}`,
        message: 'A result row does not match its reserved ARC2 job/unit/correlation identity.',
      });
      if (declared) blocked.add(declared.resultId);
      if (reserved) blocked.add(reserved.resultId);
      continue;
    }
    const matches = rowsByResult.get(reserved.resultId) ?? [];
    matches.push(row);
    rowsByResult.set(reserved.resultId, matches);
  }
  const units = inputs.map((input): AiWorkflowUnitResult => {
    const unitIssues: ValidationIssue[] = [];
    const candidates = rowsByResult.get(input.resultId) ?? [];
    let receipt: UnitReceipt | undefined;
    if (bindingInvalid || (candidates.length && !parent.executionId)) {
      unitIssues.push({
        code: 'unbound-unit-receipt', path: input.unitId,
        message: 'No result can establish a decision without the matching frozen input and execution owner.',
      });
    } else if (candidates.length > 1 || blocked.has(input.resultId)) {
      unitIssues.push({
        code: 'ambiguous-unit-receipt', path: input.unitId,
        message: 'Conflicting or duplicate result identities prevent accepting this unit.',
      });
    } else if (candidates.length === 1) {
      try {
        receipt = parseReceipt(decodeReceipt(candidates[0].cat_resultjson), input, parent, inputSha256);
        requireCondition(candidates[0].cat_itemstatus === (receipt.state === 'succeeded' ? 1 : 2),
          'The receipt state disagrees with the persisted item status.');
      } catch (error) {
        unitIssues.push({
          code: 'invalid-unit-receipt', path: input.unitId,
          message: error instanceof Error ? error.message : String(error),
        });
        receipt = undefined;
      }
    } else {
      unitIssues.push({
        code: parent.state === 'queued' || parent.state === 'running' ? 'unit-pending' : 'missing-terminal-receipt',
        path: input.unitId,
        message: parent.state === 'queued' || parent.state === 'running'
          ? 'This unit has not produced a durable terminal receipt yet.'
          : 'The terminal parent is missing this expected unit receipt.',
      });
    }
    if (receipt?.state === 'failed') unitIssues.push({
      code: 'unit-execution-failed', path: input.unitId,
      message: receipt.error?.message ?? 'The review unit failed without usable output.',
    });
    const validation = normalizeExceptionOutput(
      input, receipt?.state === 'succeeded' ? receipt.output : null, productionExceptionGuards(input.unitKind),
    );
    const diagnostics = candidates.length === 1 && typeof candidates[0].cat_errormessage === 'string'
      ? candidates[0].cat_errormessage : undefined;
    return {
      input, ...(receipt ? { receipt } : {}), validation, issues: [...unitIssues, ...validation.issues],
      ...(diagnostics ? { diagnostics } : {}),
    };
  });
  issues.push(...units.flatMap(unit => unit.issues));
  const terminal = parent.state === 'succeeded' || parent.state === 'failed';
  const transportComplete = terminal && units.every(unit => !!unit.receipt)
    && !issues.some(issue => ['foreign-result-row', 'ambiguous-unit-receipt', 'invalid-unit-receipt'].includes(issue.code));
  if (parent.state === 'succeeded' && units.some(unit => unit.receipt?.state === 'failed')) {
    issues.push({ code: 'parent-state-conflict', path: 'parent', message: 'The successful parent contains a failed unit receipt.' });
  }
  const reviewComplete = parent.state === 'succeeded' && transportComplete && issues.length === 0
    && units.every(unit => unit.validation.accepted && unit.validation.coverage === 'complete');
  return {
    request, parent, units, assessments: units.flatMap(unit => unit.validation.assessments),
    issues, transportComplete, reviewComplete,
  };
}
