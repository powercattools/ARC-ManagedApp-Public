import type { AgentCapture } from '../capture/agent-capture';
import { VALIDATION_RULES, validationProfile } from '../validation/ai-nodes/catalog';
import {
  VALIDATION_CATALOG_VERSION,
  VALIDATION_SCHEMA_VERSION,
  isRequiredScopeMetadata,
  type NodeInput,
  type NodeKind,
  type ReplayInput,
} from '../validation/ai-nodes/contracts';
import { validateNodeInput } from '../validation/ai-nodes/validate-input';
import { buildCapturedAgentUnits, buildUnboundSkillUnits } from './frozen-input';
import type { FrozenSkillEvidence } from '../validation/ai-nodes/build-units';
import { parseHostReview, type FrozenHostReview } from './provenance';
import { isObject, requireCondition, nonempty } from './wire-data';
export { isObject, requireCondition, nonempty } from './wire-data';

export const WORKFLOW_CONTRACT = 'arc2-workflow-v1' as const;
export const RESPONSE_CONTRACT = 'arc2-exceptions-v1' as const;
export const RECEIPT_CONTRACT = 'arc2-unit-result-v1' as const;
export const MAX_REVIEW_UNITS = 1000;
export const MAX_REVIEW_ATTEMPTS = 2;
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface UnitReservation {
  unitId: string;
  inputId: string;
  unitKind: NodeKind;
  resultId: string;
  componentIndex: number;
}

export interface ProductionUnit extends NodeInput {
  resultId: string;
  componentIndex: number;
}

export interface ProductionReviewRequest extends Omit<ReplayInput, 'standardReview' | 'copilotReview' | 'artifactReview'> {
  hostReview?: FrozenHostReview;
  execution: {
    contract: typeof WORKFLOW_CONTRACT;
    responseContract: typeof RESPONSE_CONTRACT;
    jobId: string;
    expectedUnitCount: number;
    units: UnitReservation[];
  };
  standardReview?: { reviewUnits: ProductionUnit[] };
  copilotReview?: {
    instructionUnit: ProductionUnit;
    skillUnits: ProductionUnit[];
    crossSkillUnit: ProductionUnit;
  };
  artifactReview?: { portionUnits: ProductionUnit[] };
}

export interface ReviewIdentity {
  jobId: string;
  correlationId: string;
}

export function newReviewIdentity(): ReviewIdentity {
  return { jobId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
}

function keys(value: object, required: string[], optional: string[] = []): void {
  requireCondition(required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key)),
  'The production request has missing or undeclared transport fields.');
}

export function productionUnits(request: ProductionReviewRequest): ProductionUnit[] {
  if (request.standardReview) return request.standardReview.reviewUnits;
  if (request.copilotReview) return [
    request.copilotReview.instructionUnit, ...request.copilotReview.skillUnits, request.copilotReview.crossSkillUnit,
  ];
  if (request.artifactReview) return request.artifactReview.portionUnits;
  throw new Error('The production request has no review route.');
}

function isUnit(value: unknown, kind: NodeKind): value is ProductionUnit {
  if (!isObject(value) || value.unitKind !== kind
    || typeof value.resultId !== 'string' || !GUID.test(value.resultId)
    || !Number.isSafeInteger(value.componentIndex) || Number(value.componentIndex) < 0
    || !Array.isArray(value.expectedAssessments)) return false;
  const subjects: string[] = [];
  for (const expected of value.expectedAssessments) {
    if (!isObject(expected) || typeof expected.subjectId !== 'string') return false;
    subjects.push(expected.subjectId);
  }
  return validateNodeInput(value, validationProfile(kind, subjects)).length === 0;
}

function parseUnit(value: unknown, kind: NodeKind): ProductionUnit {
  requireCondition(isUnit(value, kind), `The ${kind} input does not satisfy the pinned rule/evidence contract.`);
  keys(value, [
    'schemaVersion', 'catalogVersion', 'jobId', 'correlationId', 'unitId', 'inputId',
    'unitKind', 'rules', 'expectedAssessments', 'expectedRecords', 'sources', 'resultId', 'componentIndex',
  ], ['context']);
  requireCondition(value.expectedRecords.length === 0, 'Compact production requests do not support model-owned records.');
  requireCondition(nonempty(value.unitId, 100) && nonempty(value.inputId), 'A production unit identity exceeds its Dataverse limit or is empty.');
  return value;
}

function unitArray(value: unknown, kind: NodeKind): ProductionUnit[] {
  requireCondition(Array.isArray(value), 'The routed unit population must be an array.');
  return value.map(unit => parseUnit(unit, kind));
}

function unique(values: string[], message: string): void {
  requireCondition(new Set(values).size === values.length, message);
}

function requireRulePopulation(units: ProductionUnit[], kind: NodeKind): void {
  const expected = VALIDATION_RULES.filter(rule => rule.nodes.includes(kind)).map(rule => rule.id);
  const actual = units.flatMap(unit => unit.expectedAssessments.map(rule => rule.ruleId));
  requireCondition(actual.length === expected.length && expected.every(id => actual.includes(id)),
    `The ${kind} request omitted or repeated a pinned quality criterion.`);
}

/** Producer and consumer both call this. A version marker alone never upgrades a legacy corpus. */
export function parseProductionRequest(value: unknown): ProductionReviewRequest {
  requireCondition(isObject(value), 'The production review request must be an object.');
  keys(value, ['schemaVersion', 'reviewContract', 'harness', 'jobKind', 'review', 'execution'],
    ['standardReview', 'copilotReview', 'artifactReview', 'hostReview']);
  requireCondition(value.schemaVersion === VALIDATION_SCHEMA_VERSION && isObject(value.reviewContract)
    && value.reviewContract.consumer === 'arc2' && value.reviewContract.contractVersion === 3
    && value.reviewContract.catalogVersion === VALIDATION_CATALOG_VERSION
    && value.reviewContract.scoringPolicyVersion === 'arc2-unified-v3', 'The review contract version is not supported.');
  keys(value.reviewContract, ['consumer', 'contractVersion', 'catalogVersion', 'scoringPolicyVersion']);
  requireCondition(isObject(value.review), 'The production request has no review identity.');
  keys(value.review, ['correlationId', 'botId', 'botName', 'sourceEnvironment']);
  const { correlationId, botId, botName, sourceEnvironment } = value.review;
  requireCondition(nonempty(correlationId, 100) && nonempty(botId) && nonempty(botName, 200)
    && nonempty(sourceEnvironment, 1000), 'The review source/correlation identity is invalid.');
  requireCondition(isObject(value.execution), 'The production request has no execution manifest.');
  keys(value.execution, ['contract', 'responseContract', 'jobId', 'expectedUnitCount', 'units']);
  const { jobId } = value.execution;
  requireCondition(value.execution.contract === WORKFLOW_CONTRACT
    && value.execution.responseContract === RESPONSE_CONTRACT
    && typeof jobId === 'string' && GUID.test(jobId) && Array.isArray(value.execution.units),
  'The production execution contract or job identity is invalid.');
  const reservations = value.execution.units;

  const common = {
    schemaVersion: VALIDATION_SCHEMA_VERSION,
    reviewContract: {
      consumer: 'arc2' as const, contractVersion: VALIDATION_SCHEMA_VERSION,
      catalogVersion: VALIDATION_CATALOG_VERSION, scoringPolicyVersion: 'arc2-unified-v3' as const,
    },
    review: { correlationId, botId, botName, sourceEnvironment },
    execution: {
      contract: WORKFLOW_CONTRACT, responseContract: RESPONSE_CONTRACT, jobId, expectedUnitCount: 0,
      units: [] as UnitReservation[],
    },
  };
  let request: ProductionReviewRequest;
  if (value.harness === 'Standard' && value.jobKind === 'StandardReview') {
    requireCondition(isObject(value.standardReview) && !value.copilotReview && !value.artifactReview,
      'Standard requests must have exactly the Standard route.');
    keys(value.standardReview, ['reviewUnits']);
    const reviewUnits = unitArray(value.standardReview.reviewUnits, 'standard');
    requireCondition(reviewUnits.length === 5, 'Standard requests require all five review units.');
    requireRulePopulation(reviewUnits, 'standard');
    request = { ...common, harness: 'Standard', jobKind: 'StandardReview', standardReview: { reviewUnits } };
  } else if (value.harness === 'Copilot' && value.jobKind === 'StandardSkillBundle') {
    requireCondition(isObject(value.copilotReview) && !value.standardReview && !value.artifactReview,
      'Copilot requests must have exactly the Copilot route.');
    keys(value.copilotReview, ['instructionUnit', 'skillUnits', 'crossSkillUnit']);
    const instructionUnit = parseUnit(value.copilotReview.instructionUnit, 'copilot-instructions');
    const skillUnits = unitArray(value.copilotReview.skillUnits, 'copilot-skill');
    const crossSkillUnit = parseUnit(value.copilotReview.crossSkillUnit, 'cross-skill');
    requireRulePopulation([instructionUnit], 'copilot-instructions');
    requireRulePopulation([crossSkillUnit], 'cross-skill');
    for (const unit of skillUnits) requireRulePopulation([unit], 'copilot-skill');
    const skillIds = crossSkillUnit.context?.components?.map(component => component.componentId) ?? [];
    unique(skillIds, 'The skill-set population contains duplicate subjects.');
    requireCondition(skillIds.length === skillUnits.length && skillIds.every(id => skillUnits.some(unit =>
      unit.context?.components?.length === 1 && unit.context.components[0].componentId === id
        && unit.expectedAssessments.every(expected => expected.subjectId === id))),
    'The routed skill units do not cover the declared skill-set population.');
    request = {
      ...common, harness: 'Copilot', jobKind: 'StandardSkillBundle',
      copilotReview: { instructionUnit, skillUnits, crossSkillUnit },
    };
  } else if (value.harness === 'Skill' && value.jobKind === 'ArtifactBundle') {
    requireCondition(isObject(value.artifactReview) && !value.standardReview && !value.copilotReview,
      'Skill requests must have exactly the standalone artifact route.');
    keys(value.artifactReview, ['portionUnits']);
    const portionUnits = unitArray(value.artifactReview.portionUnits, 'standalone-skill');
    requireCondition(portionUnits.length === 1, 'This production contract supports one complete standalone skill, not portions.');
    requireCondition(portionUnits[0].context?.artifact?.binding === 'unbound'
      && portionUnits[0].context.artifact.sourceSkillId === botId,
    'Standalone production reviews currently require an explicit unbound skill identity.');
    requireRulePopulation(portionUnits, 'standalone-skill');
    request = { ...common, harness: 'Skill', jobKind: 'ArtifactBundle', artifactReview: { portionUnits } };
  } else {
    throw new Error('The harness/job kind is not supported by the production ARC2 reviewers.');
  }

  const units = productionUnits(request);
  requireCondition(units.length <= MAX_REVIEW_UNITS, 'The review exceeds the supported 1000-unit execution population.');
  requireCondition(value.execution.expectedUnitCount === units.length
    && value.execution.units.length === units.length, 'The execution manifest does not cover the routed unit population.');
  unique(units.map(unit => unit.unitId), 'Duplicate review unit identities are not permitted.');
  unique(units.map(unit => unit.inputId), 'Duplicate review input identities are not permitted.');
  unique(units.map(unit => unit.resultId), 'Duplicate preallocated result IDs are not permitted.');
  unique(units.flatMap(unit => unit.expectedAssessments.map(expected => expected.assessmentKey)),
    'A quality assessment cannot vote twice in one review.');
  unique(units.flatMap(unit => unit.expectedAssessments.map(expected => JSON.stringify([expected.ruleId, expected.subjectId]))),
    'A rule/subject claim cannot occur in multiple review units.');
  const sharedSources = new Map<string, { content: string; availability: string; reason?: string }>();
  for (const source of units.flatMap(unit => unit.sources)) {
    const key = JSON.stringify([source.componentId, source.fieldPath]);
    const previous = sharedSources.get(key);
    requireCondition(!previous || (previous.content === source.content && previous.availability === source.availability
      && (previous.reason ?? '') === (source.reason ?? '')), 'A shared source field differs across frozen review units.');
    sharedSources.set(key, source);
  }
  request.execution.units = units.map((unit, index) => {
    requireCondition(unit.jobId === jobId && unit.correlationId === correlationId
      && unit.inputId === `${jobId}:${unit.unitId}` && unit.componentIndex === index
      && unit.resultId !== jobId, 'A unit has an inconsistent job/input/correlation or reserved row identity.');
    requireCondition(unit.context?.agentId === botId, 'A unit belongs to a different source subject.');
    if (unit.unitKind === 'standard') {
      requireCondition(unit.expectedAssessments.filter(expected => expected.ruleId.startsWith('STD-'))
        .every(expected => expected.requiredFields.some(field => isRequiredScopeMetadata(unit, expected, field))),
      'Standard category claims require an explicit population scope; field-only legacy inputs cannot establish whole-population Pass.');
    }
    const reservation = reservations[index];
    requireCondition(isObject(reservation), 'The execution reservation is invalid.');
    keys(reservation, ['unitId', 'inputId', 'unitKind', 'resultId', 'componentIndex']);
    requireCondition(reservation.unitId === unit.unitId && reservation.inputId === unit.inputId
      && reservation.unitKind === unit.unitKind && reservation.resultId === unit.resultId
      && reservation.componentIndex === index, 'The execution reservation differs from its routed unit.');
    return { unitId: unit.unitId, inputId: unit.inputId, unitKind: unit.unitKind, resultId: unit.resultId, componentIndex: index };
  });
  request.execution.expectedUnitCount = units.length;
  if (value.hostReview !== undefined) request.hostReview = parseHostReview(value.hostReview);
  return request;
}

export function buildProductionRequest(
  units: NodeInput[],
  review: ReplayInput['review'],
  harness: ReplayInput['harness'],
  createId: () => string = () => crypto.randomUUID(),
): ProductionReviewRequest {
  requireCondition(units.length > 0, 'A production review must declare its unit population.');
  const reserved = units.map((unit, componentIndex) => ({ ...structuredClone(unit), resultId: createId(), componentIndex }));
  const request = {
    schemaVersion: VALIDATION_SCHEMA_VERSION,
    reviewContract: {
      consumer: 'arc2', contractVersion: VALIDATION_SCHEMA_VERSION,
      catalogVersion: VALIDATION_CATALOG_VERSION, scoringPolicyVersion: 'arc2-unified-v3',
    },
    harness, jobKind: harness === 'Standard' ? 'StandardReview' : harness === 'Copilot' ? 'StandardSkillBundle' : 'ArtifactBundle',
    review: { ...review },
    execution: {
      contract: WORKFLOW_CONTRACT, responseContract: RESPONSE_CONTRACT, jobId: units[0].jobId,
      expectedUnitCount: units.length,
      units: reserved.map(({ unitId, inputId, unitKind, resultId, componentIndex }) =>
        ({ unitId, inputId, unitKind, resultId, componentIndex })),
    },
    ...(harness === 'Standard' ? { standardReview: { reviewUnits: reserved } }
      : harness === 'Copilot' ? { copilotReview: {
        instructionUnit: reserved.find(unit => unit.unitKind === 'copilot-instructions'),
        skillUnits: reserved.filter(unit => unit.unitKind === 'copilot-skill'),
        crossSkillUnit: reserved.find(unit => unit.unitKind === 'cross-skill'),
      } } : { artifactReview: { portionUnits: reserved } }),
  };
  const parsed = parseProductionRequest(request);
  requireCondition(productionUnits(parsed).length === reserved.length, 'An input unit was not routed into the request.');
  return parsed;
}

export function buildCapturedAgentRequest(capture: AgentCapture, identity?: ReviewIdentity): ProductionReviewRequest {
  const stamped = identity ?? newReviewIdentity();
  if (!identity) stamped.correlationId = `${stamped.correlationId}:${capture.botId}`;
  return buildProductionRequest(buildCapturedAgentUnits(capture, stamped), {
    correlationId: stamped.correlationId, botId: capture.botId,
    botName: capture.botName, sourceEnvironment: capture.organization,
  }, capture.harness === 'standard' ? 'Standard' : 'Copilot');
}

export function buildUnboundSkillRequest(
  skill: FrozenSkillEvidence, sourceEnvironment: string, identity = newReviewIdentity(),
): ProductionReviewRequest {
  return buildProductionRequest(buildUnboundSkillUnits(skill, identity), {
    correlationId: identity.correlationId, botId: skill.id, botName: skill.name, sourceEnvironment,
  }, 'Skill');
}

export function attachHostReview(request: ProductionReviewRequest, host: FrozenHostReview): ProductionReviewRequest {
  return parseProductionRequest({ ...request, hostReview: parseHostReview(host) });
}
