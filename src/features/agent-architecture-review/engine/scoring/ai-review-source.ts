import { nativeLedgerContext, parseNativeLedger } from '../ai-workflow/native-ledger';
import { canonicalBytes, canonicalJson, parseHostReview, sha256Bytes } from '../ai-workflow/provenance';
import { parseProductionRequest, productionUnits } from '../ai-workflow/request';
import { normalizeExceptionOutput } from '../validation/ai-nodes/compact-output';
import { productionExceptionGuards } from '../validation/ai-nodes/production-guards';
import type {
  AiWorkflowLedgerContext, AiWorkflowReviewSnapshot, AiWorkflowSourceBinding, MergedAiReview,
} from './ai-review-contracts';

export const MISSING_FROZEN_NATIVE_LEDGER =
  'This saved request has no frozen native ledger; current deterministic results cannot be joined to its historical AI decisions.';

interface FrozenAiWorkflowContext {
  context: AiWorkflowLedgerContext;
  scoring: NonNullable<MergedAiReview['frozenScoring']>;
  sourceBinding: AiWorkflowSourceBinding;
}

/** A compatibility context may confirm the saved payload, never replace or supplement it. */
export function frozenAiWorkflowContext(
  snapshot: AiWorkflowReviewSnapshot, supplied?: AiWorkflowLedgerContext,
): FrozenAiWorkflowContext {
  const raw = snapshot.request.hostReview;
  let frozen: FrozenAiWorkflowContext;
  if (raw) {
    const host = parseHostReview(raw);
    const native = parseNativeLedger(host.deterministic, snapshot.request);
    const { context, options } = nativeLedgerContext(native);
    frozen = {
      context, scoring: options.evaluation ? { evaluation: structuredClone(options.evaluation) } : {},
      sourceBinding: {
        status: 'frozen-host-review', capturedAt: host.capturedAt,
        sourceFingerprint: host.sourceFingerprint, sourcePolicyVersion: native.sourcePolicyVersion,
      },
    };
  } else {
    frozen = {
      context: {
        deterministicAssessments: [],
        deterministicCoverage: { complete: false, reason: MISSING_FROZEN_NATIVE_LEDGER },
      },
      scoring: {}, sourceBinding: { status: 'missing', reason: MISSING_FROZEN_NATIVE_LEDGER },
    };
  }
  if (supplied && (canonicalJson(supplied.deterministicAssessments) !== canonicalJson(frozen.context.deterministicAssessments)
    || (raw && supplied.deterministicCoverage
      && canonicalJson(supplied.deterministicCoverage) !== canonicalJson(frozen.context.deterministicCoverage))
    || (!raw && supplied.deterministicCoverage?.complete))) {
    throw new Error('The supplied deterministic context is not the frozen native ledger stored with this AI request.');
  }
  return frozen;
}

/** Recheck the saved bytes before resolving providers, including mutations after the loader normalized them. */
export async function validateFrozenAiWorkflowSnapshot(
  snapshot: AiWorkflowReviewSnapshot,
): Promise<AiWorkflowReviewSnapshot> {
  const frozen = structuredClone(snapshot);
  const request = parseProductionRequest(frozen.request);
  if (frozen.parent.jobId !== request.execution.jobId) {
    throw new Error('The loaded workflow belongs to a different frozen request job.');
  }
  const digest = await sha256Bytes(canonicalBytes(request));
  if (frozen.parent.inputSha256 !== digest || frozen.parent.markerState !== frozen.parent.state) {
    throw new Error('The saved request, including its native ledger, does not match the execution input digest/state.');
  }
  if (frozen.parent.state !== 'queued' && !frozen.parent.executionId) {
    throw new Error('The saved workflow has no bound execution owner.');
  }
  const requested = new Map(productionUnits(request).map(input => [input.unitId, input]));
  if (frozen.units.length !== requested.size) {
    throw new Error('The loaded workflow has a different frozen unit population.');
  }
  const seen = new Set<string>();
  for (const unit of frozen.units) {
    const input = requested.get(unit.input.unitId);
    if (!input || seen.has(input.unitId) || canonicalJson(unit.input) !== canonicalJson(input)) {
      throw new Error('A loaded AI unit does not match its exact saved input.');
    }
    seen.add(input.unitId);
    const receipt = unit.receipt;
    if (receipt && (receipt.inputSha256 !== digest || receipt.jobId !== request.execution.jobId
      || receipt.unitId !== input.unitId || receipt.inputId !== input.inputId || receipt.unitKind !== input.unitKind
      || receipt.resultId !== input.resultId || receipt.componentIndex !== input.componentIndex
      || receipt.flowRunId !== frozen.parent.executionId)) {
      throw new Error('An AI receipt is not bound to the saved request and its execution owner.');
    }
    if (!receipt && frozen.transportComplete) {
      throw new Error('The workflow cannot declare complete transport without every frozen unit receipt.');
    }
    const validation = normalizeExceptionOutput(
      input, receipt?.state === 'succeeded' ? receipt.output : null, productionExceptionGuards(input.unitKind),
    );
    if (!unit.validation || canonicalJson(unit.validation) !== canonicalJson(validation)) {
      throw new Error('An AI decision was not normalized against its exact saved input and receipt.');
    }
  }
  return { ...frozen, request };
}
