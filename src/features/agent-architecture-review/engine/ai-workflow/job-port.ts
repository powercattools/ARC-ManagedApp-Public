import type { EngineTransport } from '../contracts/transport';
import { ARC2_QUEUED_STATUS } from '../dispatch/ai-workflow-review-job';
import {
  REVIEW_JOB_ENTITY_SET, REVIEW_JOB_ITEM_ENTITY_SET, ReviewHarness, ReviewJobStatus, corpusKindToJobKind,
} from '../scoring/art-ports';
import {
  GUID, isObject, parseProductionRequest, requireCondition, type ProductionReviewRequest,
} from './request';
import {
  normalizeWorkflowResults, parseWorkflowParent, type AiWorkflowSnapshot,
} from './receipt';
import { canonicalBytes, canonicalJson, sha256Bytes } from './provenance';
import { executionMarker, queuedMarker } from './execution-marker';

const PARENT_COLUMNS = [
  'cat_agentreviewjobid', 'cat_botid', 'cat_botname', 'cat_correlationid', 'cat_jobstatus',
  'cat_harness', 'cat_jobkind', 'cat_componentcount', 'cat_laststatus', 'cat_errormessage', 'modifiedon',
].join(',');
const ITEM_COLUMNS = [
  'cat_agentreviewjobitemid', '_cat_jobid_value', 'cat_componentid', 'cat_componentindex',
  'cat_correlationid', 'cat_itemstatus', 'cat_resultjson', 'cat_errormessage', 'createdon',
].join(',');

export interface AiWorkflowPort {
  /** One deliberate handoff. No requeue, implicit AI fallback, or automatic resubmission. */
  submit(request: ProductionReviewRequest): Promise<string>;
  /** Reads persisted results. It never invokes a model or changes a row. */
  read(jobId: string, expectedRequest?: ProductionReviewRequest): Promise<AiWorkflowSnapshot>;
  /** Explicit recovery of a missed finalizer only; never requeues or reruns an incomplete unit. */
  reconcileCompleted(jobId: string): Promise<AiWorkflowSnapshot>;
}

export class AiWorkflowSubmissionError extends Error {
  constructor(readonly jobId: string, readonly phase: string, cause: unknown) {
    super(`ARC2 submission ${jobId} stopped during ${phase}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'AiWorkflowSubmissionError';
  }
}

function validJobId(jobId: string): string {
  requireCondition(GUID.test(jobId), 'The ARC2 job ID must be a lowercase Dataverse GUID.');
  return jobId;
}

function parseInputBytes(bytes: Uint8Array): ProductionReviewRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    throw new Error('The stored ARC2 input file is not valid UTF-8 JSON.', { cause: error });
  }
  return parseProductionRequest(parsed);
}

function exactBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function parentVersion(raw: unknown): string {
  requireCondition(isObject(raw) && typeof raw['@odata.etag'] === 'string'
    && raw['@odata.etag'].trim() && raw['@odata.etag'] !== '*',
  'The parent read did not expose an exact row version; an unconditional handoff or settlement is not safe.');
  return raw['@odata.etag'];
}

export function createAiWorkflowPort(transport: EngineTransport): AiWorkflowPort {
  const readParent = (jobId: string) => transport.get(`${REVIEW_JOB_ENTITY_SET}(${jobId})?$select=${PARENT_COLUMNS}`);
  const readItems = (jobId: string) => transport.rows(
    `${REVIEW_JOB_ITEM_ENTITY_SET}?$select=${ITEM_COLUMNS}`
      + `&$filter=${encodeURIComponent(`_cat_jobid_value eq ${jobId}`)}`
      + `&$orderby=${encodeURIComponent('cat_componentindex asc,createdon asc')}`,
  );
  const readInput = (jobId: string) => transport.file(`${REVIEW_JOB_ENTITY_SET}(${jobId})/cat_inputfile/$value`);
  async function load(jobId: string, expectedRequest?: ProductionReviewRequest) {
    validJobId(jobId);
    const storedBytes = await readInput(jobId);
    const request = parseInputBytes(storedBytes);
    requireCondition(exactBytes(storedBytes, canonicalBytes(request)),
      'The stored request is not the immutable canonical input file produced by this contract.');
    requireCondition(request.execution.jobId === jobId, 'The stored input belongs to a different job.');
    if (expectedRequest) requireCondition(
      canonicalJson(request) === canonicalJson(parseProductionRequest(expectedRequest)),
      'The stored input changed after submission; its results cannot be compared against the prior snapshot.',
    );
    const parent = await readParent(jobId);
    const rows = await readItems(jobId);
    return { request, parent, rows, snapshot: await normalizeWorkflowResults(request, parent, rows) };
  }
  return {
    async submit(untrusted) {
      // Freeze bytes before the first await. Caller edits can no longer rewrite this submission.
      const request = parseProductionRequest(structuredClone(untrusted));
      const jobId = validJobId(request.execution.jobId);
      const bytes = canonicalBytes(request);
      const inputSha256 = await sha256Bytes(bytes);
      let phase = 'creating the parent';
      let created = false;
      let handedOff = false;
      try {
        const response = await transport.request('POST', REVIEW_JOB_ENTITY_SET, {
          cat_agentreviewjobid: jobId,
          cat_name: `ARC2 - ${request.review.botName}`.slice(0, 100),
          cat_botid: `arc2:${jobId}`,
          cat_botname: request.review.botName,
          cat_correlationid: request.review.correlationId,
          cat_jobstatus: ARC2_QUEUED_STATUS,
          cat_jobkind: corpusKindToJobKind(request.jobKind),
          cat_harness: ReviewHarness[request.harness],
          cat_componentcount: request.execution.expectedUnitCount,
          cat_laststatus: 'ARC2 compact input is being prepared; not handed off.',
        });
        requireCondition(response.status >= 200 && response.status < 300,
          `The parent insert failed (HTTP ${response.status}). Existing parents are never reused.`);
        created = true;
        phase = 'uploading the input';
        await transport.putFile(REVIEW_JOB_ENTITY_SET, jobId, 'cat_inputfile', 'arc2-review-request.json', bytes);
        phase = 'checking the frozen upload';
        const rawParent = await readParent(jobId);
        const parent = parseWorkflowParent(rawParent, request);
        requireCondition(parent.state === 'queued', 'The parent was already claimed; this client will not requeue it.');
        const etag = parentVersion(rawParent);
        const stored = await readInput(jobId);
        requireCondition(exactBytes(stored, bytes), 'The uploaded input bytes differ from this frozen request.');
        parseInputBytes(stored);
        requireCondition((await readItems(jobId)).length === 0, 'The new parent already has results; it will not be requeued.');
        phase = 'handing off the queue';
        // A lost response is ambiguous; never retry or mark a possibly claimed job failed here.
        handedOff = true;
        await transport.patch(`${REVIEW_JOB_ENTITY_SET}(${jobId})`, {
          cat_jobstatus: ARC2_QUEUED_STATUS,
          cat_laststatus: queuedMarker(inputSha256),
        }, etag);
        return jobId;
      } catch (error) {
        if (created && !handedOff) {
          try {
            const rawParent = await readParent(jobId);
            const parent = parseWorkflowParent(rawParent, request);
            if (parent.state === 'queued') await transport.patch(`${REVIEW_JOB_ENTITY_SET}(${jobId})`, {
              cat_jobstatus: ReviewJobStatus.Failed,
              cat_laststatus: 'ARC2 submission failed before queue handoff.',
              cat_errormessage: error instanceof Error ? error.message : String(error),
            }, parentVersion(rawParent));
          } catch (settlementError) {
            throw new AiWorkflowSubmissionError(jobId, phase, new AggregateError(
              [error, settlementError], 'Submission failed and its unqueued parent could not be settled.',
            ));
          }
        }
        throw new AiWorkflowSubmissionError(jobId, phase, error);
      }
    },
    async read(jobId, expectedRequest) {
      return (await load(jobId, expectedRequest)).snapshot;
    },
    async reconcileCompleted(jobId) {
      const loaded = await load(jobId);
      const { snapshot } = loaded;
      if (snapshot.parent.state === 'succeeded' || snapshot.parent.state === 'failed') return snapshot;
      requireCondition(snapshot.parent.state === 'running' && snapshot.parent.executionId
        && snapshot.parent.inputSha256 && snapshot.units.every(unit => !!unit.receipt),
      'Reconciliation requires an owned Running parent and every durable terminal receipt; missing work is never rerun automatically.');
      const failed = snapshot.units.some(unit => unit.receipt?.state === 'failed');
      const update = {
        cat_jobstatus: failed ? ReviewJobStatus.Failed : ReviewJobStatus.Succeeded,
        cat_laststatus: executionMarker(snapshot.parent.executionId, snapshot.parent.inputSha256,
          failed ? 'failed' : 'succeeded', `Reconciled ${snapshot.units.length} durable receipts; no model rerun.`),
        cat_errormessage: failed ? 'One or more persisted reviewer units failed; inspect their retained receipts.' : '',
      };
      requireCondition(isObject(loaded.parent), 'The parent cannot be reconciled without its versioned row.');
      const candidate = await normalizeWorkflowResults(loaded.request, { ...loaded.parent, ...update }, loaded.rows);
      requireCondition(candidate.transportComplete, 'Conflicting receipt identities or provenance prevent finalization.');
      await transport.patch(`${REVIEW_JOB_ENTITY_SET}(${jobId})`, update, parentVersion(loaded.parent));
      return (await load(jobId, loaded.request)).snapshot;
    },
  };
}
