import type { AgentCapture, CopilotAgentCapture } from '../capture/agent-capture';
import { normalizeStandardComponents } from '../harnesses/standard/standard-component-normalization';
import {
  buildCorpusComponent,
  buildReviewCorpus,
  buildStandardReviewWorkflowCorpus,
  detectArtifactKind,
  extractStandardSnapshot,
  findFile,
  redactSecrets,
  toSkillBundle,
  type UploadedArtifact,
} from '../scoring/art-ports';
import {
  buildCopilotUnits,
  buildStandaloneSkillUnit,
  buildStandardUnits,
  prepareRecordedCopilotEvidence,
  prepareRecordedSkillEvidence,
  type BuildIdentity,
  type FrozenCopilotEvidence,
  type FrozenSkillEvidence,
  type ScopeDeclaration,
} from '../validation/ai-nodes/build-units';
import type { NodeInput, SourceField } from '../validation/ai-nodes/contracts';
import type { SkillIdentity } from '../harnesses/skill/skill-identity';
import { VALIDATION_RULES } from '../validation/ai-nodes/catalog';
import { capturedCapabilityInventory } from './capability-inventory';
import { isObject } from './wire-data';

const complete: ScopeDeclaration = {
  availability: 'complete',
  reason: 'The successful frozen capture supplied this complete population.',
};

function capturedField(componentId: string, fieldPath: string, content: string): SourceField {
  return { componentId, fieldPath, content, availability: 'complete' };
}

/** A successful capture is required; failed or partial acquisition must not use this adapter. */
export function freezeCapturedCopilotEvidence(capture: CopilotAgentCapture): FrozenCopilotEvidence {
  const skillIds = capture.model.skills.map(skill => skill.componentId);
  if (skillIds.some(id => !id) || new Set(skillIds).size !== skillIds.length
    || capture.bundles.length !== skillIds.length
    || new Set(capture.bundles.map(bundle => bundle.skillComponentId)).size !== skillIds.length
    || capture.bundles.some(bundle => !skillIds.includes(bundle.skillComponentId))) {
    throw new Error('The frozen skill inventory and assembled bundles do not describe the same complete population.');
  }
  const instructions = redactSecrets(capture.model.agentSettings.instructions ?? '');
  const declaredInstructions = capture.model.agentSettings.raw.instructions;
  const readableInstructions = declaredInstructions == null || typeof declaredInstructions === 'string'
    || isObject(declaredInstructions) && (typeof declaredInstructions.value === 'string'
      || Array.isArray(declaredInstructions.segments)
        && declaredInstructions.segments.every(segment => isObject(segment) && typeof segment.value === 'string'));
  const capabilities = capturedCapabilityInventory(capture);
  let skills: FrozenSkillEvidence[] = [];
  if (capture.bundles.length) {
    // Use ART's existing redaction/resource-excerpt boundary; manifest presence is not file readability.
    const corpus = buildReviewCorpus(
      capture.bundles.map(bundle => ({ ...bundle, agentInstructions: capture.model.agentSettings.instructions ?? '' })),
      new Map(),
      capture.model,
      {
        botId: capture.botId, botName: capture.botName, sourceEnvironment: capture.organization,
        correlationId: 'frozen-capture-only', harness: 'Copilot',
      },
    );
    const frozen = prepareRecordedCopilotEvidence(corpus, {
      instructions: complete, capabilities: complete, population: complete,
      skills: new Map(capture.bundles.map(bundle => [bundle.skillComponentId, {
        markdown: !bundle.skillMarkdown && bundle.retrievalIssues.some(issue => issue.severity === 'error')
          ? { availability: 'unavailable', reason: 'The skill capture failed before readable markdown was established.' }
          : redactSecrets(bundle.skillMarkdown) !== bundle.skillMarkdown
            ? { availability: 'partial', reason: 'Sensitive substrings were redacted; hidden spans are not complete authored evidence.' }
            : complete,
        manifest: {
          availability: bundle.retrievalIssues.some(issue => issue.severity === 'error') ? 'partial' : 'complete',
          reason: bundle.retrievalIssues.some(issue => issue.severity === 'error')
            ? 'The frozen skill capture reported resource retrieval errors.'
            : complete.reason,
        },
      }])),
    });
    skills = frozen.skills;
  }
  const unknownKinds = capture.model.unknownKinds;
  const populationPartial = Array.isArray(unknownKinds) && unknownKinds.length > 0
    || capabilities.unreviewedExecutableComponents.length > 0;
  const inventoryScope = populationPartial ? {
    availability: 'partial' as const,
    reason: 'The parser retained unknown or unrepresented executable components; the capability population is not proven complete.',
  } : { availability: 'complete' as const };
  const frozen: FrozenCopilotEvidence = {
    agentId: capture.botId,
    agentName: capture.botName,
    instructions: !readableInstructions
      ? { componentId: capture.botId, fieldPath: 'agent_instructions', content: '', availability: 'unavailable',
        reason: 'The captured instruction payload has an unreadable shape; parser defaults are not authored empty instructions.' }
      : instructions !== capture.model.agentSettings.instructions
        ? { componentId: capture.botId, fieldPath: 'agent_instructions', content: instructions, availability: 'partial',
          reason: 'Sensitive substrings were redacted; hidden spans are not complete authored evidence.' }
        : capturedField(capture.botId, 'agent_instructions', instructions),
    capabilities: {
      componentId: capture.botId, fieldPath: 'configuredCapabilities',
      content: JSON.stringify(capabilities), ...inventoryScope,
    },
    population: {
      componentId: capture.botId, fieldPath: 'skill_inventory',
      content: JSON.stringify(skills.map(skill => ({ componentId: skill.id, name: skill.name }))),
      ...inventoryScope,
    },
    skills,
  };
  // INS-07 and SKL-09 are `execution: 'ai'`, so there is no deterministic
  // verdict to hand the node as a hint; both nodes decide them on their own.
  return frozen;
}

export function buildCapturedAgentUnits(capture: AgentCapture, identity: BuildIdentity): NodeInput[] {
  if (capture.harness === 'copilot') return buildCopilotUnits(freezeCapturedCopilotEvidence(capture), identity);
  const snapshot = extractStandardSnapshot({
    botId: capture.botId, name: capture.botName, configuration: capture.configuration,
    description: capture.agentDescription, agentSettings: capture.agentSettings,
  }, normalizeStandardComponents(capture.components), 'live');
  const populationIncomplete = snapshot.configurationAvailable === false || !!snapshot.unknownComponents?.length
    || snapshot.topicComponents.some(topic => topic.ParseStatus === 'unavailable');
  const population: ScopeDeclaration = populationIncomplete
    ? { availability: 'partial', reason: 'The captured Standard component population contains unavailable or unparseable configuration.' }
    : complete;
  const scopes = new Map(VALIDATION_RULES.filter(rule => rule.nodes.includes('standard')).map(rule => [rule.id, population]));
  for (const [ruleId, callables] of [
    ['STD-TOL-ROUTING-DESCRIPTION', snapshot.toolDetails ?? []],
    ['STD-CON-DELEGATION-DESCRIPTION', snapshot.connectedAgents ?? []],
  ] as const) {
    if (callables.some(callable => !callable.description?.trim())) {
      scopes.set(ruleId, {
        availability: 'partial',
        reason: 'A captured callable has no description. The current Standard catalog has no approved presence-check owner; semantic clarity cannot establish complete coverage of this population.',
      });
    }
  }
  return buildStandardUnits(buildStandardReviewWorkflowCorpus(snapshot, {
    correlationId: identity.correlationId, sourceEnvironment: capture.organization,
  }), identity, scopes);
}

/** Standalone profiles deliberately never inherit the source agent's capability inventory. */
export function buildUnboundSkillUnits(skill: FrozenSkillEvidence, identity: BuildIdentity): NodeInput[] {
  return [buildStandaloneSkillUnit(skill, identity)];
}

export function freezeUploadedSkillEvidence(
  artifact: UploadedArtifact,
  identity: SkillIdentity,
  withheldPaths: readonly string[] = [],
): FrozenSkillEvidence {
  const detection = detectArtifactKind(artifact);
  if (detection.kind !== 'skill') {
    throw new Error(detection.reason ?? 'This AI workflow supports skill uploads, not automation or declarative-agent artifacts.');
  }
  if (identity.contentHash !== artifact.hash || !identity.subjectId.trim() || !identity.displayName.trim()) {
    throw new Error('The uploaded skill identity does not match the frozen artifact.');
  }
  const bundle = toSkillBundle({ artifact, withheldPaths });
  const primary = findFile(artifact, 'SKILL.md');
  const markdownUnavailable = !primary || primary.isBinary || primary.text === undefined
    || withheldPaths.includes(primary.path) || (detection.primaryPath !== undefined && withheldPaths.includes(detection.primaryPath));
  if (markdownUnavailable) bundle.skillMarkdown = '';
  bundle.skillComponentId = identity.subjectId;
  bundle.skillComponentUniqueId = identity.subjectId;
  bundle.skillName = identity.displayName;
  return prepareRecordedSkillEvidence(buildCorpusComponent(bundle, [], [], 0), {
    markdown: markdownUnavailable
      ? { availability: 'unavailable', reason: 'The uploaded SKILL.md is unreadable or explicitly withheld.' }
      : complete,
    manifest: complete,
  });
}
