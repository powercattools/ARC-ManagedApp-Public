/**
 * The Knowledge pillar — four rules about what an agent can ground an answer in.
 *
 * Two of them are records: the knowledge inventory and the memory setting state
 * what was configured rather than judging it, because neither is a measured
 * answer-quality result. The other two are checks with opposite shapes — KNW-02
 * reads the instructions and asks whether a promise made there has a source
 * behind it, and KNW-03 reads the tool inventory and asks whether a preview
 * connector is being relied on.
 *
 * The wording, severities and references below are the ones ART has published
 * since spec 013 and are reproduced verbatim; this file changes where they are
 * declared, not what they say.
 */

import type { AeTool, AgentsExperienceModel } from '../../agents-experience/contracts/AgentsExperienceModel';
import { norm } from '../../agents-experience/services/rules/ruleTypes';
import { failWith, notApplicable, pass, record, rule, type Rule } from '../rule';

const COPILOT = ['copilot'] as const;

/** Detects a knowledge promise in instruction text, independent of any source inventory. */
const KNOWLEDGE_PROMISE = /\bknowledge base\b|\bdocumentation\b|\bour docs\b|\bknowledge sources?\b/;

/**
 * Tools whose captured connector identifier matches the Work IQ detector.
 *
 * Exported because ART quotes one evidence row per matched tool, and re-running
 * the detector at the publication site would make the match two declarations
 * that merely happen to agree. The rule owns the predicate; the host owns the
 * evidence shape it needs from the result.
 */
export function workIqTools(model: AgentsExperienceModel): readonly AeTool[] {
  return model.tools.filter(t => /a365/i.test(t.connectorId ?? ''));
}

export const KNW_01: Rule<AgentsExperienceModel> = rule<AgentsExperienceModel>({
  id: 'KNW-01',
  title: 'Knowledge inventory',
  harnesses: COPILOT,
  pillar: 'knowledge',
  subjectScope: 'agent',
  execution: 'deterministic',
  severity: 'info',
  prose: {
    question: 'What can this agent ground an answer in: which knowledge sources, and is web search on?',
    summary: 'Record captured knowledge sources and the web-search setting.',
    why: 'Knowledge configuration provides context for grounding, not a measured answer-quality score.',
    fix: 'No action required. Keep the knowledge inventory current.',
    passWhen: [
      'At least one knowledge source is captured.',
      'The web-search setting is explicitly configured.',
    ],
    failWhen: [],
    notApplicableWhen: ['No knowledge sources and no explicit web-search setting are configured.'],
  },
  tags: ['quality', 'token-optimizer'],
  references: ['ms-knowledge-add'],
  evidence: {
    fieldPaths: ['knowledge/agentSettings.enableWebSearch'],
    populations: ['knowledge', 'configuration'],
  },
  check(model) {
    if (model.knowledge.length === 0 && model.agentSettings.enableWebSearch === undefined) {
      return notApplicable('No knowledge sources or explicit web-search setting are configured.');
    }
    return record([{
      title: `Knowledge inventory: ${model.knowledge.length} sources`,
      detail: [...model.knowledge.map(k => `${k.name} (${k.sourceKind ?? '?'})`),
        `webSearch: ${model.agentSettings.enableWebSearch ?? false}`].join('\n'),
      why: 'Knowledge sources define what the agent can reference when answering.',
      makerAction: 'No action required. Inventory shown for the review record.',
    }]);
  },
});

export const KNW_02: Rule<AgentsExperienceModel> = rule<AgentsExperienceModel>({
  id: 'KNW-02',
  title: 'Instruction knowledge promises have a configured source',
  harnesses: COPILOT,
  pillar: 'knowledge',
  subjectScope: 'agent',
  execution: 'deterministic',
  severity: 'medium',
  prose: {
    question: 'Where the instructions promise knowledge, is there a source or web search behind it?',
    summary: 'Compare detected knowledge promises with the source inventory and web-search setting.',
    why: 'Knowledge promises should have a configured grounding source.',
    fix: 'Add the source, enable appropriate web search or remove the unsupported promise.',
    passWhen: [
      'At least one knowledge source is captured.',
      'Web search is explicitly enabled.',
    ],
    failWhen: [
      'The instructions promise knowledge while no source is configured and web search is not enabled.',
    ],
    notApplicableWhen: ['No knowledge promise matches the base detector.'],
    failTitle: 'Instructions promise knowledge the agent does not have',
  },
  tags: ['quality'],
  references: ['ms-knowledge-add'],
  evidence: {
    fieldPaths: ['agentSettings.instructions/knowledge/agentSettings.enableWebSearch'],
    populations: ['instructions', 'knowledge', 'configuration'],
    completeForFailure: ['knowledge', 'configuration'],
  },
  check(model) {
    const text = norm(model.agentSettings.instructions);
    const promises = KNOWLEDGE_PROMISE.test(text);
    const hasKnowledge = model.knowledge.length > 0 || model.agentSettings.enableWebSearch === true;
    if (!promises) return notApplicable('No knowledge promise matches the base detector.');
    if (hasKnowledge) return pass();
    return failWith([{
      title: 'Instructions promise knowledge the agent does not have',
      detail: `instructions reference knowledge; configured sources: 0; web search: ${model.agentSettings.enableWebSearch ?? false}`,
      why: 'The agent cannot answer from a knowledge base it is not connected to.',
      makerAction: 'Add the knowledge source, enable web search, or remove the promise from the instructions.',
    }]);
  },
});

export const KNW_03: Rule<AgentsExperienceModel> = rule<AgentsExperienceModel>({
  id: 'KNW-03',
  title: 'Work IQ tool release readiness is reviewed',
  harnesses: COPILOT,
  pillar: 'knowledge',
  subjectScope: 'agent',
  execution: 'deterministic',
  severity: 'medium',
  prose: {
    question: 'Does this agent rely on a Work IQ preview connector?',
    summary: 'Identify tools whose captured connector identifier matches the base Work IQ detector.',
    why: 'Release-readiness guidance should be reviewed before production; this detector does not observe runtime reliability.',
    fix: 'Check the current Work IQ release guidance before production promotion.',
    passWhen: ['No captured tool resolves to a Work IQ connector.'],
    failWhen: ['At least one captured tool resolves to a Work IQ connector.'],
    notApplicableWhen: ['No Work IQ connector is identified in the complete captured inventory.'],
    failTitle: 'Work IQ preview tools in use',
  },
  tags: ['quality', 'token-optimizer'],
  references: ['ms-work-iq'],
  evidence: { fieldPaths: ['tools.connectorId'], populations: ['tools'] },
  check(model) {
    const workIq = workIqTools(model);
    if (workIq.length === 0) {
      return notApplicable('No Work IQ connector is identified in the complete captured inventory.');
    }
    return failWith([{
      title: `${workIq.length} Work IQ preview tools in use`,
      detail: workIq.map(t => `${t.name} → ${t.connectorId}`).join('\n'),
      why: 'Work IQ MCP is a preview feature and not intended for production use.',
      makerAction: 'Track the Work IQ MCP release status before promoting this agent to production.',
    }]);
  },
});

export const KNW_04: Rule<AgentsExperienceModel> = rule<AgentsExperienceModel>({
  id: 'KNW-04',
  title: 'Memory configuration',
  harnesses: COPILOT,
  pillar: 'knowledge',
  subjectScope: 'agent',
  execution: 'deterministic',
  severity: 'info',
  prose: {
    question: 'Is memory explicitly enabled on this agent?',
    summary: 'Record whether memory is explicitly enabled.',
    why: 'Memory settings provide data-handling context, not a quality-score contribution.',
    fix: 'Confirm enabled memory fits the intended data-handling requirements.',
    passWhen: ['Memory is explicitly enabled.'],
    failWhen: [],
    notApplicableWhen: ['Memory is not explicitly enabled.'],
  },
  tags: ['quality', 'security', 'token-optimizer'],
  references: ['ms-memory'],
  evidence: { fieldPaths: ['agentSettings.enableMemory'], populations: ['configuration'] },
  check(model) {
    if (model.agentSettings.enableMemory !== true) {
      return notApplicable('Memory is not explicitly enabled.');
    }
    return record([{
      title: 'Memory is enabled',
      detail: 'agentSettings.enableMemory: true',
      why: 'Memory persists user preferences per user across sessions.',
      makerAction: 'Confirm memory\'s per-user persistence fits your data-handling requirements.',
    }]);
  },
});

export const knowledgeRules: readonly Rule<AgentsExperienceModel>[] = Object.freeze([
  KNW_01, KNW_02, KNW_03, KNW_04,
]);
