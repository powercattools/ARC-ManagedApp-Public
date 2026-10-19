import { ARC2_QUEUED_STATUS } from '../dispatch/ai-workflow-review-job';
import { buildStandardReviewWorkflowCorpus, extractStandardSnapshot, ReviewHarness, corpusKindToJobKind } from '../scoring/art-ports';
import { buildCopilotUnits, buildStandaloneSkillUnit, buildStandardUnits, type FrozenCopilotEvidence, type FrozenSkillEvidence } from '../validation/ai-nodes/build-units';
import type { ProductionReviewRequest, ProductionUnit } from './request';
import { buildProductionRequest, productionUnits, RECEIPT_CONTRACT, RESPONSE_CONTRACT } from './request';
import type { UnitReceipt } from './receipt';
import { createHash } from 'node:crypto';
import { canonicalJson } from './provenance';
import { executionMarker, queuedMarker } from './execution-marker';

export const TEST_EXECUTION_ID = 'arc2-execution:00000000-0000-4000-8000-000000000501';
export const inputHashFixture = (request: ProductionReviewRequest) =>
  createHash('sha256').update(canonicalJson(request)).digest('hex');

export const TEST_IDENTITY = {
  jobId: '00000000-0000-4000-8000-000000000101',
  correlationId: '00000000-0000-4000-8000-000000000102',
};

export function skillFixture(id = 'skill-one'): FrozenSkillEvidence {
  return {
    id, name: id,
    markdown: {
      componentId: id, fieldPath: 'skill_markdown', availability: 'complete',
      content: '---\nname: find-item\ndescription: Find catalog items.\n---\nAsk for the item ID. Return the matching record.',
    },
    manifest: { componentId: id, fieldPath: 'resource_manifest', availability: 'complete', content: '[]' },
    resources: [], resourceCount: 0,
  };
}

export function requestFixture(harness: 'Standard' | 'Copilot' | 'Skill' = 'Copilot', skillCount = 0): ProductionReviewRequest {
  const skill = skillFixture();
  const botId = harness === 'Skill' ? skill.id : 'agent-one';
  const review = {
    botId, botName: 'Catalog Assistant', correlationId: TEST_IDENTITY.correlationId, sourceEnvironment: 'https://example.test',
  };
  let nextId = 200;
  const id = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;
  if (harness === 'Standard') {
    const snapshot = extractStandardSnapshot({
      botId, name: review.botName, configuration: '{"settings":{"GenerativeActionsEnabled":true}}',
    }, [], 'live');
    snapshot.agentInstructions = 'You answer catalog questions. Ask when an item ID is missing.';
    const corpus = buildStandardReviewWorkflowCorpus(snapshot, review);
    return buildProductionRequest(buildStandardUnits(corpus, TEST_IDENTITY), review, harness, id);
  }
  if (harness === 'Skill') return buildProductionRequest([buildStandaloneSkillUnit(skill, TEST_IDENTITY)], review, harness, id);
  const skills = Array.from({ length: skillCount }, (_, index) => skillFixture(`skill-${index}`));
  const evidence: FrozenCopilotEvidence = {
    agentId: botId, agentName: review.botName, skills,
    instructions: {
      componentId: botId, fieldPath: 'agent_instructions', availability: 'complete',
      content: 'You help employees find catalog items. Be concise. Ask for missing IDs. Only answer catalog questions. Escalate unresolved requests.',
    },
    capabilities: { componentId: botId, fieldPath: 'configuredCapabilities', availability: 'complete', content: '[]' },
    population: {
      componentId: botId, fieldPath: 'skill_inventory', availability: 'complete',
      content: JSON.stringify(skills.map(item => ({ componentId: item.id, name: item.name }))),
    },
  };
  return buildProductionRequest(buildCopilotUnits(evidence, TEST_IDENTITY), review, harness, id);
}

export function parentFixture(request: ProductionReviewRequest, status: number = ARC2_QUEUED_STATUS): Record<string, unknown> {
  return {
    '@odata.etag': 'W/"fixture-version"',
    cat_agentreviewjobid: request.execution.jobId, cat_botid: `arc2:${request.execution.jobId}`,
    cat_correlationid: request.review.correlationId, cat_componentcount: request.execution.expectedUnitCount,
    cat_jobstatus: status, cat_harness: ReviewHarness[request.harness], cat_jobkind: corpusKindToJobKind(request.jobKind),
    cat_laststatus: status === ARC2_QUEUED_STATUS ? queuedMarker(inputHashFixture(request))
      : executionMarker(TEST_EXECUTION_ID, inputHashFixture(request),
        status === 2 ? 'running' : status === 3 ? 'succeeded' : 'failed'),
    cat_errormessage: null,
  };
}

export function receiptFixture(input: ProductionUnit, request: ProductionReviewRequest): UnitReceipt {
  return {
    contract: RECEIPT_CONTRACT, jobId: input.jobId, unitId: input.unitId, inputId: input.inputId,
    unitKind: input.unitKind, resultId: input.resultId, componentIndex: input.componentIndex,
    state: 'succeeded', attemptCount: 1, flowRunId: TEST_EXECUTION_ID, inputSha256: inputHashFixture(request),
    output: {
      responseContract: RESPONSE_CONTRACT, unitId: input.unitId, inputId: input.inputId,
      processedAllExpectedRules: true, failures: [], notAssessed: [], hybridResolutions: [],
    },
    error: null,
  };
}

export function receiptRow(
  input: ProductionUnit, request: ProductionReviewRequest, receipt = receiptFixture(input, request),
): Record<string, unknown> {
  return {
    cat_agentreviewjobitemid: input.resultId, _cat_jobid_value: input.jobId,
    cat_componentid: input.unitId, cat_componentindex: input.componentIndex,
    cat_correlationid: input.correlationId, cat_itemstatus: receipt.state === 'succeeded' ? 1 : 2,
    cat_resultjson: JSON.stringify(receipt),
  };
}

export function completeRows(request: ProductionReviewRequest): Record<string, unknown>[] {
  return productionUnits(request).map(input => receiptRow(input, request));
}
