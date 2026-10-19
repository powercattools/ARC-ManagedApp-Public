import { STANDARD_WORKFLOW_RULES, type ReviewCorpus, type StandardReviewWorkflowCorpus } from '../../scoring/art-ports';
import {
  fieldKey,
  VALIDATION_CATALOG_VERSION,
  VALIDATION_SCHEMA_VERSION,
  type Availability,
  type DeterministicAssessment,
  type ExpectedAssessment,
  type FieldRef,
  type NodeInput,
  type NodeKind,
  type NodeRule,
  type SourceField,
} from './contracts';
import { VALIDATION_RULES, validationProfile, validationRule } from './catalog';
import { validateNodeInput } from './validate-input';

export interface BuildIdentity {
  jobId: string;
  correlationId: string;
}

export interface ScopeDeclaration {
  availability: Availability;
  reason: string;
}

export interface FrozenSkillEvidence {
  id: string;
  name: string;
  markdown: SourceField;
  manifest: SourceField;
  resources: SourceField[];
  resourceCount: number;
  deterministicCapabilityAssessment?: DeterministicAssessment;
}

export interface FrozenCopilotEvidence {
  agentId: string;
  agentName: string;
  instructions: SourceField;
  capabilities: SourceField;
  population: SourceField;
  skills: FrozenSkillEvidence[];
  deterministicInstructionAssessment?: DeterministicAssessment;
}

export interface RecordedCopilotScope {
  instructions: ScopeDeclaration;
  capabilities: ScopeDeclaration;
  population: ScopeDeclaration;
  skills: ReadonlyMap<string, { markdown: ScopeDeclaration; manifest: ScopeDeclaration }>;
}

const asRef = ({ componentId, fieldPath }: FieldRef): FieldRef => ({ componentId, fieldPath });
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const nonempty = (value: string, label: string) => {
  if (!value?.trim()) throw new Error(`${label} must be supplied by the frozen capture.`);
};

function source(
  componentId: string,
  fieldPath: string,
  content: string,
  scope: ScopeDeclaration,
): SourceField {
  nonempty(scope.reason, `The availability reason for ${componentId}/${fieldPath}`);
  return {
    componentId, fieldPath, content: scope.availability === 'unavailable' ? '' : content,
    availability: scope.availability,
    ...(scope.availability === 'complete' ? {} : { reason: scope.reason }),
  };
}

function unit(
  identity: BuildIdentity,
  unitId: string,
  unitKind: NodeKind,
  context: NonNullable<NodeInput['context']>,
): NodeInput {
  nonempty(identity.jobId, 'jobId');
  nonempty(identity.correlationId, 'correlationId');
  return {
    schemaVersion: VALIDATION_SCHEMA_VERSION,
    catalogVersion: VALIDATION_CATALOG_VERSION,
    ...identity,
    unitId,
    inputId: `${identity.jobId}:${unitId}`,
    unitKind,
    context,
    rules: [],
    expectedAssessments: [],
    expectedRecords: [],
    sources: [],
  };
}

function addSources(input: NodeInput, sources: SourceField[]): FieldRef[] {
  const byKey = new Map(input.sources.map(item => [fieldKey(item), item]));
  for (const item of sources) {
    const previous = byKey.get(fieldKey(item));
    if (previous && !same(previous, item)) {
      throw new Error(`Conflicting captured values for ${fieldKey(item)}.`);
    }
    if (!previous) {
      const copy = structuredClone(item);
      input.sources.push(copy);
      byKey.set(fieldKey(copy), copy);
    }
  }
  return sources.map(asRef);
}

function assessment(
  input: NodeInput,
  ruleId: string,
  subjectId: string,
  sources: SourceField[],
  applicability: ExpectedAssessment['applicability'],
  eligibleComponentIds: string[],
  absenceFields: FieldRef[] = [],
  deterministicAssessment?: DeterministicAssessment,
): void {
  const definition = validationRule(ruleId, input.unitKind);
  const fields = addSources(input, sources);
  input.expectedAssessments.push({
    assessmentKey: `${subjectId}:${ruleId}`,
    ruleId, subjectId, execution: definition.execution,
    applicability: structuredClone(applicability),
    eligibleComponentIds: [...eligibleComponentIds],
    allowedFields: fields,
    allowedAbsenceFields: structuredClone(absenceFields),
    requiredFields: structuredClone(fields),
    ...(deterministicAssessment ? { deterministicAssessment: structuredClone(deterministicAssessment) } : {}),
  });
}

/**
 * The node-facing rule set is projected from the finished assessments, never assembled alongside
 * them, so a late applicability or scope correction can never leave the node reading a stale rule.
 */
function nodeRules(input: NodeInput): NodeRule[] {
  return input.expectedAssessments.map(expected => {
    const { contract } = validationRule(expected.ruleId, input.unitKind);
    return {
      ruleId: expected.ruleId,
      name: contract.title,
      category: contract.category,
      evaluationQuestion: contract.question,
      failWhen: [...contract.failWhen],
      rejectWhen: [...contract.notApplicableWhen],
      applicability: {
        status: expected.applicability.state,
        eligibleComponentIds: [...expected.eligibleComponentIds],
      },
      requiredEvidence: {
        allowedFieldPaths: [...new Set(expected.allowedFields.map(field => field.fieldPath))],
        allowEmptyQuoteForAbsence: expected.allowedAbsenceFields.length > 0,
      },
    };
  });
}

function finish(input: NodeInput): NodeInput {
  input.rules = nodeRules(input);
  const issues = validateNodeInput(input, validationProfile(input.unitKind,
    [...new Set(input.expectedAssessments.map(item => item.subjectId))]));
  if (issues.length) {
    throw new Error(`Invalid prepared ${input.unitId}: ${issues.map(issue => `${issue.code}: ${issue.message}`).join('; ')}`);
  }
  return input;
}

type StandardComponent = StandardReviewWorkflowCorpus['standardReview']['reviewUnits'][number]['corpus']['agent']['components'][number];

function standardFieldScope(component: StandardComponent, path: string): ScopeDeclaration {
  let status: unknown;
  if (path.startsWith('fields.input')) status = component.facts.inputVariablesStatus;
  else if (path.startsWith('fields.output')) status = component.facts.outputVariablesStatus;
  else if (path === 'fields.modelDescription') status = component.facts.modelDescriptionStatus;
  else if (path.startsWith('fields.trigger')) status = component.facts.triggerQueriesStatus;
  else if (path === 'fields.modelName') status = component.facts.parseStatus;
  const availability: Availability = status === 'partial' ? 'partial'
    : status === 'unavailable' ? 'unavailable' : 'complete';
  return {
    availability,
    reason: availability === 'complete'
      ? 'The recorded corpus contains this exact field in its declared eligible population.'
      : `The recorded corpus marks the source metadata ${availability}.`,
  };
}

/** Preserve authored string leaves, rather than turning quotes/newlines into JSON escape sequences. */
function stringLeaves(componentId: string, path: string, value: unknown, scope: ScopeDeclaration): SourceField[] {
  if (scope.availability === 'unavailable') return [source(componentId, path, '', scope)];
  if (typeof value === 'string') return [source(componentId, path, value, scope)];
  if (Array.isArray(value)) {
    return value.length
      ? value.flatMap((item, index) => stringLeaves(componentId, `${path}[${index}]`, item, scope))
      : [source(componentId, path, '[]', scope)];
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => stringLeaves(componentId, `${path}.${key}`, item, scope));
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return [source(componentId, path, JSON.stringify(value), scope)];
  }
  return [source(componentId, path, '', { availability: 'unavailable', reason: 'This permitted field was not captured.' })];
}

export function buildStandardUnits(
  corpus: StandardReviewWorkflowCorpus,
  identity: BuildIdentity,
  populationScopes: ReadonlyMap<string, ScopeDeclaration> = new Map(),
): NodeInput[] {
  if (corpus.schemaVersion !== 2 || corpus.jobKind !== 'StandardReview'
    || corpus.standardReview.reviewUnits.length !== 5) {
    throw new Error('The Standard adapter requires the recorded five-unit V2 corpus.');
  }
  const seenUnits = new Set<string>();
  const seenRules = new Set<string>();
  const output = corpus.standardReview.reviewUnits.map(legacy => {
    if (seenUnits.has(legacy.unitId)) throw new Error('The recorded Standard unit identity is duplicated.');
    seenUnits.add(legacy.unitId);
    const body = legacy.corpus;
    if (body.review.botId !== corpus.review.botId
      || body.reviewUnit.unitId !== legacy.unitId
      || body.reviewUnit.componentIndex !== legacy.componentIndex) {
      throw new Error('The recorded Standard unit and parent identities disagree.');
    }
    const input = unit(identity, legacy.unitId, 'standard', {
      agentId: corpus.review.botId,
      agentName: corpus.review.botName,
      scope: 'The exact eligible population and permitted fields declared by the recorded ART unit, not a claim to have reviewed unavailable native components.',
      purpose: body.agent.purpose,
      orchestrationMode: body.agent.orchestrationMode,
      reviewLimits: [...body.agent.reviewLimits],
      components: body.agent.components.map(item => ({
        componentId: item.componentId, name: item.name, componentType: item.componentType,
      })),
    });
    const components = new Map(body.agent.components.map(item => [item.componentId, item]));
    if (components.size !== body.agent.components.length) throw new Error('Duplicate Standard component identity.');
    for (const legacyRule of body.standardReview.rules) {
      const template = STANDARD_WORKFLOW_RULES.find(item => item.ruleId === legacyRule.ruleId);
      if (!template || template.evaluationQuestion !== legacyRule.evaluationQuestion
        || !same(template.failWhen, legacyRule.failWhen)
        || !same(template.rejectWhen, legacyRule.rejectWhen)
        || !same(template.allowedFieldPaths, legacyRule.requiredEvidence.allowedFieldPaths)) {
        throw new Error(`Recorded rule ${legacyRule.ruleId} differs from the pinned ART definition; review the contract before replay.`);
      }
      const ids = legacyRule.ruleId === 'STD-PATTERN-TOOL-ROUTING-GAP'
        ? ['STD-TOL-ROUTING-DESCRIPTION', 'STD-CON-DELEGATION-DESCRIPTION']
        : [legacyRule.ruleId];
      for (const id of ids) {
        if (seenRules.has(id)) throw new Error(`Repeated Standard claim ${id}.`);
        seenRules.add(id);
        const eligible = legacyRule.applicability.eligibleComponentIds.map(componentId => {
          const component = components.get(componentId);
          if (!component) throw new Error(`Eligible component ${componentId} is missing from its recorded unit.`);
          return component;
        }).filter(component =>
          id === 'STD-TOL-ROUTING-DESCRIPTION' ? component.componentType === 'tool'
            : id === 'STD-CON-DELEGATION-DESCRIPTION' ? component.componentType === 'connected-agent' : true);
        const applicability: ExpectedAssessment['applicability'] = {
          state: legacyRule.applicability.status,
          reason: legacyRule.applicability.reason,
        };
        if (ids.length === 2 && !eligible.length && applicability.state === 'applicable') {
          applicability.state = 'not-applicable';
          applicability.reason = `No ${id === 'STD-TOL-ROUTING-DESCRIPTION' ? 'tool' : 'connected-agent'} is eligible in the recorded callable population.`;
        }
        const fields = eligible.flatMap(component => {
          const permitted = legacyRule.requiredEvidence.allowedFieldPaths;
          const existing = permitted.filter(path => Object.hasOwn(component.fields, path.replace(/^fields\./, '')));
          return (existing.length ? existing : permitted.slice(0, 1)).flatMap(path => stringLeaves(
            component.componentId, path, component.fields[path.replace(/^fields\./, '')],
            standardFieldScope(component, path),
          ));
        });
        assessment(input, id, corpus.review.botId, fields, applicability,
          eligible.map(item => item.componentId),
          legacyRule.requiredEvidence.allowEmptyQuoteForAbsence
            ? fields.filter(item => item.fieldPath === 'fields.instructions' && item.availability === 'complete').map(asRef) : []);
        if (legacyRule.category !== 'instructions') {
          const population = populationScopes.get(id) ?? {
            availability: 'unavailable' as const,
            reason: 'The recorded ART corpus does not establish the completeness of its eligible component population.',
          };
          const incompleteFieldPopulation = body.agent.components.some(component =>
            legacyRule.requiredEvidence.allowedFieldPaths.some(path =>
              standardFieldScope(component, path).availability !== 'complete'));
          const scope = population.availability === 'complete' && incompleteFieldPopulation
            ? { availability: 'partial' as const, reason: 'One or more captured components have incomplete metadata needed to establish this rule population.' }
            : population;
          const scopeField = source(corpus.review.botId, `$scope.${id}.population`,
            scope.availability === 'unavailable' ? '' : JSON.stringify({ eligibleComponentIds: eligible.map(item => item.componentId) }),
            scope);
          const expected = input.expectedAssessments[input.expectedAssessments.length - 1];
          // Population coverage is required context, never authored evidence a model can quote as a defect.
          expected.requiredFields.push(...addSources(input, [scopeField]));
          const generativeTriggerExclusion = id === 'STD-PATTERN-MISSING-TRIGGERS'
            && body.agent.orchestrationMode === 'generative';
          if (scope.availability !== 'complete' && expected.applicability.state === 'not-applicable'
            && !generativeTriggerExclusion) {
            expected.applicability = { state: 'not-assessed', reason: scope.reason };
          }
        }
      }
    }
    return finish(input);
  });
  const expected = VALIDATION_RULES.filter(item => item.nodes.includes('standard'));
  if (seenRules.size !== expected.length || expected.some(item => !seenRules.has(item.id))) {
    throw new Error('The recorded Standard corpus does not supply the full pinned 25-rule population.');
  }
  return output;
}

export function prepareRecordedSkillEvidence(
  component: ReviewCorpus['components'][number],
  declared: { markdown: ScopeDeclaration; manifest: ScopeDeclaration },
): FrozenSkillEvidence {
  nonempty(component.skillComponentId, 'The recorded skill identity');
  const excerpts = new Map(component.resource_excerpts.map(item => [item.path, item]));
  const manifestPaths = new Set(component.resource_manifest.map(item => item.path));
  if (excerpts.size !== component.resource_excerpts.length
    || manifestPaths.size !== component.resource_manifest.length
    || [...excerpts.keys()].some(item => !manifestPaths.has(item))) {
    throw new Error('Resource paths are duplicated or an excerpt is outside the recorded manifest.');
  }
  return {
    id: component.skillComponentId,
    name: component.skillName,
    markdown: source(component.skillComponentId, 'skill_markdown', component.skill_markdown, declared.markdown),
    manifest: source(component.skillComponentId, 'resource_manifest', JSON.stringify(component.resource_manifest), declared.manifest),
    resourceCount: component.resource_manifest.length,
    resources: component.resource_manifest.map(item => {
      const excerpt = excerpts.get(item.path);
      const blocked = item.isBinary || /withheld|blocked|unreadable/i.test(item.analysisStatus);
      if (blocked && excerpt) throw new Error(`An excluded resource ${item.path} unexpectedly contains a submitted excerpt.`);
      const availability: Availability = blocked || !excerpt ? 'unavailable' : excerpt.truncated ? 'partial' : 'complete';
      return source(component.skillComponentId, `resources[${JSON.stringify(item.path)}].content`, excerpt?.content ?? '', {
        availability,
        reason: blocked ? 'Binary, withheld or unreadable resource; do not reconstruct its content.'
          : !excerpt ? 'The manifest establishes existence, but no content was included in the recorded input.'
            : excerpt.truncated ? 'The recorded excerpt is truncated.' : 'The recorded complete resource excerpt is available.',
      });
    }),
  };
}

/** Convert a frozen, already-redacted corpus with separately declared source availability. */
export function prepareRecordedCopilotEvidence(
  corpus: ReviewCorpus,
  scope: RecordedCopilotScope,
): FrozenCopilotEvidence {
  if (corpus.schemaVersion !== 1 || corpus.jobKind !== 'StandardSkillBundle') {
    throw new Error('The adapter requires a recorded ART StandardSkillBundle corpus.');
  }
  if (!corpus.components.length) {
    throw new Error('A zero-skill legacy corpus has no independent instruction source. Supply FrozenCopilotEvidence from a real agent capture instead.');
  }
  const instructionValues = new Set(corpus.components.map(item => item.agent_instructions));
  const capabilityValues = new Set(corpus.components.map(item => JSON.stringify(item.configuredCapabilities)));
  if (instructionValues.size !== 1 || capabilityValues.size !== 1) {
    throw new Error('Repeated ART agent context disagrees across skills; selecting the first skill would hide a source conflict.');
  }
  const instructions = instructionValues.values().next().value;
  const capabilities = capabilityValues.values().next().value;
  if (typeof instructions !== 'string' || typeof capabilities !== 'string') {
    throw new Error('Independent instruction and capability values could not be established.');
  }
  const seen = new Set<string>();
  const skills = corpus.components.map(component => {
    nonempty(component.skillComponentId, 'The recorded skill identity');
    if (seen.has(component.skillComponentId)) throw new Error('Duplicate recorded skill identity.');
    seen.add(component.skillComponentId);
    const declared = scope.skills.get(component.skillComponentId);
    if (!declared) throw new Error(`No source availability declaration for ${component.skillComponentId}.`);
    return prepareRecordedSkillEvidence(component, declared);
  });
  return {
    agentId: corpus.review.botId,
    agentName: corpus.review.botName,
    instructions: source(corpus.review.botId, 'agent_instructions', instructions, scope.instructions),
    capabilities: source(corpus.review.botId, 'configuredCapabilities', capabilities, scope.capabilities),
    population: source(corpus.review.botId, 'skill_inventory',
      JSON.stringify(skills.map(skill => ({ componentId: skill.id, name: skill.name }))), scope.population),
    skills,
  };
}

function readableApplicability(field: SourceField): ExpectedAssessment['applicability'] {
  return field.availability === 'unavailable'
    ? { state: 'not-assessed', reason: field.reason ?? 'The required field is unavailable.' }
    : { state: 'applicable', reason: 'The declared field is available for evidence-bound assessment; incomplete scope cannot establish a whole-scope Pass.' };
}

export function buildCopilotInstructionUnit(
  evidence: FrozenCopilotEvidence,
  identity: BuildIdentity,
): NodeInput {
  const input = unit(identity, 'copilot-instructions', 'copilot-instructions', {
    agentId: evidence.agentId, agentName: evidence.agentName,
    scope: 'Independent captured agent instructions. Skills are not the instruction evidence source.',
  });
  for (const definition of VALIDATION_RULES.filter(item => item.nodes.includes('copilot-instructions'))) {
    const applicable = readableApplicability(evidence.instructions);
    if (evidence.instructions.availability === 'complete' && !evidence.instructions.content.trim()) {
      applicable.state = 'not-applicable';
      applicable.reason = 'The complete instruction field is empty; INS-01 owns the missing-instructions condition.';
    }
    const fields = definition.id === 'INS-07'
      ? [evidence.instructions, evidence.capabilities] : [evidence.instructions];
    assessment(input, definition.id, evidence.agentId, fields, applicable, [evidence.agentId],
      fields.filter(item => item.availability === 'complete').map(asRef),
      definition.id === 'INS-07' ? evidence.deterministicInstructionAssessment : undefined);
  }
  return finish(input);
}

function buildSkillUnit(
  skill: FrozenSkillEvidence,
  identity: BuildIdentity,
  parent?: FrozenCopilotEvidence,
): NodeInput {
  const kind: NodeKind = parent ? 'copilot-skill' : 'standalone-skill';
  const input = unit(identity, `${kind}:${skill.id}`, kind, {
    agentId: parent?.agentId ?? skill.id,
    agentName: parent?.agentName ?? skill.name,
    scope: parent ? 'One complete declared skill with its captured parent capability context.'
      : 'One unbound standalone skill, with unchanged captured markdown/resources and no inherited parent-agent capability inventory.',
    components: [{ componentId: skill.id, name: skill.name, componentType: 'skill' }],
    ...(!parent ? { artifact: { kind: 'skill' as const, binding: 'unbound' as const, sourceSkillId: skill.id } } : {}),
  });
  for (const definition of VALIDATION_RULES.filter(item => item.nodes.includes(kind))) {
    const applicable = readableApplicability(skill.markdown);
    const fields = definition.id === 'SKL-AI-CLARITY'
      ? [skill.markdown]
      : [skill.markdown, skill.manifest, ...skill.resources];
    if (definition.id === 'SKL-09') {
      if (parent) fields.push(parent.capabilities);
      else {
        applicable.state = 'not-applicable';
        applicable.reason = 'This standalone skill is unbound. No target-agent capability inventory exists for SKL-09.';
      }
    }
    if (definition.id === 'SKL-AI-RESOURCE-ALIGNMENT'
      && skill.manifest.availability === 'complete' && skill.resourceCount === 0) {
      applicable.state = 'not-applicable';
      applicable.reason = 'The complete captured resource manifest is empty; there is no attached resource content to assess for semantic alignment.';
    }
    assessment(input, definition.id, skill.id, fields, applicable, [skill.id],
      fields.filter(item => item.availability === 'complete').map(asRef),
      definition.id === 'SKL-09' && parent ? skill.deterministicCapabilityAssessment : undefined);
  }
  return finish(input);
}

export function buildCrossSkillUnit(evidence: FrozenCopilotEvidence, identity: BuildIdentity): NodeInput {
  const input = unit(identity, 'copilot-cross-skill', 'cross-skill', {
    agentId: evidence.agentId, agentName: evidence.agentName,
    scope: 'One category-level assessment per declared skill-set criterion. Pair defects are details, not separate assessments.',
    components: evidence.skills.map(skill => ({ componentId: skill.id, name: skill.name, componentType: 'skill' })),
  });
  const fields = [evidence.population, ...evidence.skills.flatMap(skill => [
    skill.markdown, skill.manifest, ...skill.resources,
  ])];
  for (const definition of VALIDATION_RULES.filter(item => item.nodes.includes('cross-skill'))) {
    const applicable = readableApplicability(evidence.population);
    if (definition.id !== 'XSK-04' && evidence.population.availability === 'complete' && evidence.skills.length < 2) {
      applicable.state = 'not-applicable';
      applicable.reason = 'The complete declared set contains fewer than two skills for this set/pair criterion.';
    }
    const permitted = definition.id === 'XSK-04' ? [...fields, evidence.instructions, evidence.capabilities] : fields;
    assessment(input, definition.id, `${evidence.agentId}:skill-set`, permitted, applicable,
      evidence.skills.map(skill => skill.id),
      permitted.filter(item => item.availability === 'complete').map(asRef));
  }
  return finish(input);
}

export function buildCopilotUnits(evidence: FrozenCopilotEvidence, identity: BuildIdentity): NodeInput[] {
  if (new Set(evidence.skills.map(item => item.id)).size !== evidence.skills.length) {
    throw new Error('A captured skill cannot be submitted twice in the same Copilot case.');
  }
  return [
    buildCopilotInstructionUnit(evidence, identity),
    ...evidence.skills.map(skill => buildSkillUnit(skill, identity, evidence)),
    buildCrossSkillUnit(evidence, identity),
  ];
}

export function buildStandaloneSkillUnit(skill: FrozenSkillEvidence, identity: BuildIdentity): NodeInput {
  return buildSkillUnit(skill, identity);
}
