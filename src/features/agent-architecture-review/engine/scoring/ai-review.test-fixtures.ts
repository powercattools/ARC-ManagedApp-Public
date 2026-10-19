import {
  buildStandardReviewWorkflowCorpus, extractStandardSnapshot, type UnifiedRuleAssessment,
} from './art-ports';
import {
  buildCopilotUnits, buildStandaloneSkillUnit, buildStandardUnits,
  type FrozenCopilotEvidence, type FrozenSkillEvidence,
} from '../validation/ai-nodes/build-units';
import type { Evidence, ExpectedAssessment, NodeInput } from '../validation/ai-nodes/contracts';
import { normalizeExceptionOutput, type ExceptionOutput } from '../validation/ai-nodes/compact-output';
import { productionExceptionGuards } from '../validation/ai-nodes/production-guards';
import { mergeAiReview, type AiReviewUnit, type MergeAiReviewInput } from './ai-review-merge';
import type { AiEvaluationSignals } from './ai-review-scoring';

export const subjectId = 'captured-agent';
const identity = { jobId: 'job-fixture', correlationId: 'correlation-fixture' };

export function skillEvidence(id = 'skill-one'): FrozenSkillEvidence {
  return {
    id, name: 'Same display name',
    markdown: { componentId: id, fieldPath: 'skill_markdown', availability: 'complete',
      content: '---\nname: lookup-item\ndescription: Look up one catalog item.\n---\nCall Lookup Item with the supplied item ID. Return the item. Ask when the ID is missing.' },
    manifest: { componentId: id, fieldPath: 'resource_manifest', availability: 'complete', content: '[]' },
    resources: [], resourceCount: 0,
  };
}

export function copilotInputs(count = 1): NodeInput[] {
  const skills = Array.from({ length: count }, (_, index) => skillEvidence(`skill-${index}`));
  const evidence: FrozenCopilotEvidence = {
    agentId: subjectId, agentName: 'Captured fixture',
    instructions: { componentId: subjectId, fieldPath: 'agent_instructions', availability: 'complete',
      content: 'You are the catalog assistant for employees. Be concise. Answer only catalog requests. Ask for missing item IDs. Escalate unsupported requests to Support. Call Lookup Item for catalog items.' },
    capabilities: { componentId: subjectId, fieldPath: 'configuredCapabilities', availability: 'complete', content: '["Lookup Item","Support"]' },
    population: { componentId: subjectId, fieldPath: 'skill_inventory', availability: 'complete',
      content: JSON.stringify(skills.map(skill => ({ componentId: skill.id, name: skill.name }))) },
    skills,
  };
  return buildCopilotUnits(evidence, identity);
}

export function standaloneInput(): NodeInput {
  return buildStandaloneSkillUnit(skillEvidence('uploaded-skill'), identity);
}

export function standardInputs(): NodeInput[] {
  const snapshot = extractStandardSnapshot({
    botId: subjectId, name: 'Standard fixture', configuration: '{"settings":{"GenerativeActionsEnabled":true}}',
  }, [], 'live');
  snapshot.agentInstructions = 'Answer catalog questions. Ask for missing item IDs. Escalate unsupported requests to Support.';
  return buildStandardUnits(buildStandardReviewWorkflowCorpus(snapshot, {
    correlationId: 'recorded-correlation', sourceEnvironment: 'https://example.test',
  }), identity);
}

export function expected(input: NodeInput, ruleId: string): ExpectedAssessment {
  const value = input.expectedAssessments.find(item => item.ruleId === ruleId);
  if (!value) throw new Error(`Fixture has no ${ruleId}.`);
  return value;
}

export function quote(input: NodeInput, ruleId: string): Evidence {
  const permitted = expected(input, ruleId).allowedFields;
  const source = input.sources.find(item => item.content && permitted.some(field =>
    item.componentId === field.componentId && item.fieldPath === field.fieldPath));
  if (!source) throw new Error(`Fixture has no readable field for ${ruleId}.`);
  return { componentId: source.componentId, fieldPath: source.fieldPath, kind: 'quote', quote: source.content };
}

// The live flow's schema still declares `hybridResolutions` required, so `productionExceptionGuards`
// still validates its shape. These fixtures model a real node payload, so they must carry the key
// even though `ExceptionOutput` no longer declares it. Delete once flow 782 drops the field.
const WIRE_HYBRIDS_EMPTY = { hybridResolutions: [] } as Partial<ExceptionOutput>;

export function cleanOutput(input: NodeInput): ExceptionOutput {
  return {
    responseContract: 'arc2-exceptions-v1', unitId: input.unitId, inputId: input.inputId,
    processedAllExpectedRules: true, failures: [], notAssessed: [], ...WIRE_HYBRIDS_EMPTY,
  };
}

export function failedOutput(input: NodeInput, ruleId: string, findingCount = 1): ExceptionOutput {
  return {
    ...cleanOutput(input),
    failures: [{
      assessmentKey: expected(input, ruleId).assessmentKey, scopeStatus: 'complete',
      findings: Array.from({ length: findingCount }, (_, index) => ({
        fact: `The captured instructions leave required decision ${index + 1} unspecified.`,
        evidence: [quote(input, ruleId)],
        remediation: {
          findingTitle: 'Specify the required decision', whyItMatters: 'The procedure otherwise depends on a guess.',
          makerAction: 'State the required decision in this instruction.', acceptanceCheck: 'The instruction states the decision.',
        },
      })),
    }],
  };
}

export function normalized(input: NodeInput, raw: unknown = cleanOutput(input)): AiReviewUnit {
  return { input, validation: normalizeExceptionOutput(input, raw, productionExceptionGuards(input.unitKind)) };
}

export function deterministic(
  ruleId = 'TOL-04', outcome: UnifiedRuleAssessment['outcome'] = 'pass',
  overrides: Partial<UnifiedRuleAssessment> = {},
): UnifiedRuleAssessment {
  return {
    key: `copilot:${ruleId}:agent`, ruleId, harness: 'copilot', family: 'Tools',
    severity: 'high', kind: 'check', outcome, title: `Registered ${ruleId}`, fact: 'Captured deterministic fact.',
    why: 'This registered criterion has a supported correction.', fix: 'Apply the supported correction.',
    tags: ['quality'], source: 'deterministic', incomplete: outcome === 'could-not-run',
    reason: outcome === 'could-not-run' ? 'The required capture failed.' : outcome === 'not-applicable' ? 'The captured population is absent.' : '',
    referenceIds: ['fixture-policy'],
    evidence: [{ componentId: subjectId, fieldPath: 'agent_instructions', quote: 'Captured evidence', status: 'verified' }],
    findings: outcome === 'fail' ? [{
      id: ruleId, instanceId: `${ruleId}:finding`, title: 'An established defect', fact: 'Captured deterministic defect.',
      why: 'The defect matters.', fix: 'Fix the defect.', severity: 'high',
      evidence: [{ componentId: subjectId, fieldPath: 'agent_instructions', quote: 'Captured evidence', status: 'verified' }],
      referenceIds: ['fixture-policy'],
    }] : [],
    ...overrides,
  };
}

export function baseDeterministic(): UnifiedRuleAssessment[] {
  return [
    deterministic('INS-01', 'pass', { family: 'Instructions' }),
    deterministic('TOL-04'),
    deterministic('KNW-02', 'pass', { family: 'Knowledge', severity: 'medium' }),
    deterministic('EVL-01', 'pass', { family: 'Evaluation', severity: 'medium' }),
  ];
}

export function review(units = copilotInputs().map(input => normalized(input)), overrides: Partial<MergeAiReviewInput> = {}) {
  return mergeAiReview({
    harness: 'copilot', subjectId, units, deterministicAssessments: baseDeterministic(),
    deterministicCoverage: { complete: true, reason: 'This test supplies the complete declared deterministic fixture ledger.' },
    ...overrides,
  });
}

export const fullEvaluation: AiEvaluationSignals = {
  availability: 'complete', reason: 'The captured usable set and cases establish every supplied Evaluation signal.',
  hasUsableSet: true, hasCases: true, capabilityCoverageRatio: 1,
  hasMultiTurnCoverage: true, expectedResponseRequirementSatisfied: true,
};
