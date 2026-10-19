/**
 * The Knowledge family now lives in `review-core/rules/knowledge.rules.ts`.
 *
 * This file is the ART publication point: it takes each rule as declared once
 * and hands it to the Copilot machinery that owns availability, evidence
 * synthesis and finding verification. Nothing about what a rule decides is
 * restated here.
 *
 * Two of the four quote narrower evidence than ART would synthesize from the
 * finding - KNW-02 quotes the instruction text, KNW-03 quotes one row per
 * matched tool - and `UnifiedEvidence` is an ART contract that `review-core`
 * deliberately does not model. Those quotes are therefore supplied below, at the
 * boundary that owns the contract, through the shared adapter's `evidence` hook.
 */
import { workIqTools, KNW_01, KNW_02, KNW_03, KNW_04 } from '../../../review-core/rules/knowledge.rules';
import { capturedEvidence } from './copilotEvidence';
import { defineCoreCopilotRule } from './copilotRuleDefinition';

const FAMILY = 'Knowledge';

const registered = [
  defineCoreCopilotRule(KNW_01, { family: FAMILY, kind: 'record' }),
  defineCoreCopilotRule(KNW_02, {
    family: FAMILY,
    evidence: model => [{
      fieldPath: 'agentSettings.instructions', status: 'verified', quote: model.agentSettings.instructions,
      reason: 'The knowledge promise is compared with captured knowledge-source and web-search configuration.',
    }],
  }),
  defineCoreCopilotRule(KNW_03, {
    family: FAMILY,
    optionalPopulation: 'tools',
    evidence: model => workIqTools(model).map(t => capturedEvidence(t, 'tools.connectorId', t.connectorId)),
  }),
  defineCoreCopilotRule(KNW_04, { family: FAMILY, kind: 'record' }),
];

export const knowledgeRules = registered.map(rule => rule.legacy);
export const unifiedKnowledgeRules = registered.map(rule => rule.unified);
