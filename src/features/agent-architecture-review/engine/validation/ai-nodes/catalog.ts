import { COMPLIANCE_CRITERIA, STANDARD_WORKFLOW_RULES } from '../../scoring/art-ports';
import type { ExpectedAssessment, NodeKind, NodeRuleCategory, RuleContract, ValidationProfile } from './contracts';

export interface ValidationRuleDefinition {
  id: string;
  execution: ExpectedAssessment['execution'];
  nodes: readonly NodeKind[];
  contract: RuleContract;
  sourceDefinition: string;
}

const completeEvidence = 'Inspect the complete permitted source scope; an empty finding list is not positive evidence.';
const standardSource = 'ART/utils/standardReviewWorkflowRules.ts';
const approvedSource = 'specs/022-unified-ai-review/rule-map.md';
const skillNodes: readonly NodeKind[] = ['copilot-skill', 'standalone-skill'];

/** The node prompts carry the ART category vocabulary, so approved rules declare it from their node routing. */
const ruleCategory = (nodes: readonly NodeKind[]): NodeRuleCategory =>
  nodes.includes('copilot-instructions') ? 'instructions'
    : nodes.includes('cross-skill') ? 'routing' : 'configuration';

function standardDefinitions(): ValidationRuleDefinition[] {
  return STANDARD_WORKFLOW_RULES.flatMap(template => {
    const ids = template.ruleId === 'STD-PATTERN-TOOL-ROUTING-GAP'
      ? ['STD-TOL-ROUTING-DESCRIPTION', 'STD-CON-DELEGATION-DESCRIPTION']
      : [template.ruleId];
    const criterion = COMPLIANCE_CRITERIA.find(item => item.id === template.ruleId);
    return ids.map(id => ({
      id,
      execution: 'ai' as const,
      nodes: ['standard'] as const,
      sourceDefinition: `${standardSource}#${template.ruleId}`,
      contract: {
        title: id === 'STD-TOL-ROUTING-DESCRIPTION' ? 'Tool Routing Description'
          : id === 'STD-CON-DELEGATION-DESCRIPTION' ? 'Connected-Agent Delegation Description'
            : template.name,
        category: template.category,
        question: [
          template.evaluationQuestion,
          ...(criterion ? [`Required behavior: ${criterion.description}.`] : []),
          `Failure-rejection boundaries from ART: ${template.rejectWhen.join(' ')}`,
          'A clear field satisfies the criterion; it is not an exclusion. Unavailable evidence is not an authored omission.',
        ].join('\n'),
        passWhen: [
          ...(criterion ? [criterion.description] : [
            'Each eligible component satisfies the stated quality question, and the complete reviewed population establishes none of the supplied failure conditions.',
          ]),
          completeEvidence,
        ],
        failWhen: [...template.failWhen],
        notApplicableWhen: [
          'The frozen ART corpus applicability policy proves that no component is eligible for this criterion.',
          ...(id === 'persona-and-tone'
            ? ['No supplied non-default situation requires specific response behavior. Professional and polite behavior alone is not a missing-tone defect.'] : []),
          ...(id === 'formatting-guidelines'
            ? ['No supplied task requires structured or multi-part output. A neutral formatting preference is not a deficiency.'] : []),
        ],
        why: template.description,
        fix: template.recommendation,
      },
    }));
  });
}

function definition(
  id: string,
  title: string,
  nodes: readonly NodeKind[],
  question: string,
  passWhen: string[],
  failWhen: string[],
  why: string,
  fix: string,
  notApplicableWhen: string[] = [],
): ValidationRuleDefinition {
  return {
    id,
    execution: 'ai',
    nodes,
    sourceDefinition: `${approvedSource}#${id}`,
    contract: {
      title, category: ruleCategory(nodes), question,
      passWhen: [...passWhen, completeEvidence], failWhen, notApplicableWhen, why, fix,
    },
  };
}

const instructionElements = [
  ['INS-02', 'Role and Audience', 'the agent role and who it serves'],
  ['INS-03', 'Response Tone', 'how the agent should sound or address the user'],
  ['INS-04', 'Instruction Boundaries', 'what the agent must not do or where its remit ends'],
  ['INS-05', 'Ambiguity Handling', 'what to do when the request is unclear or required information is missing'],
  ['INS-06', 'Escalation Guidance', 'when and how to hand off to a human or another agent'],
] as const;

const instructionDefinitions = instructionElements.map(([id, title, behavior]) => definition(
  id, title, ['copilot-instructions'],
  `Do the complete agent instructions directly state ${behavior}? Do not infer coverage from the agent name, its writing style, or plausible platform behavior.`,
  [`An exact instruction statement directly establishes ${behavior}.`],
  [`The complete, nonempty instruction field does not directly state ${behavior}; a merely implied statement is not coverage.`],
  `Without explicit ${behavior}, the agent's intended behavior is underspecified.`,
  `Add an instruction that directly states ${behavior}, using this agent's actual context.`,
  ['The instruction field is confirmed empty and the missing-instructions condition belongs to INS-01. Failed retrieval is not this exclusion.'],
));

const capabilityQuestion = [
  'Do explicit named-capability invocations resolve against the complete captured target inventory?',
  'Inspect invoke, call, send, read, write, delegate and query directives, whether names are quoted or not.',
  'Consider all supplied names, evidenced aliases and documented broad execution surfaces; do not invent capability semantics.',
  'Descriptions, examples, prohibitions, native runtime output and ordinary response text are not invocations.',
  'An unresolved plausible mapping requires not-assessed, not a guessed absence.',
].join(' ');
const capabilityPass = [
  'Every explicit invocation is supported by the supplied complete target inventory and its evidenced aliases/capabilities, or the complete applicable text contains no such invocation.',
];
const capabilityFail = [
  'An actual directive invokes a capability absent from the complete supplied inventory, after all evidenced aliases and execution surfaces have been considered. Cite the directive and the complete inventory field.',
];

const sharedSkillDefinitions: ValidationRuleDefinition[] = [
  definition('SKL-09', 'Skill Capability Alignment', skillNodes, capabilityQuestion,
    capabilityPass, capabilityFail,
    'A skill cannot carry out a directive whose required capability is unavailable on its declared target.',
    'Use an actually configured capability with its correct identity, or supply the required capability on the bound target.',
    ['The standalone review is explicitly unbound. An empty inventory does not establish missing tools.']),
  definition('SKL-10', 'Consistent Skill and Resource Instructions', skillNodes,
    'Can the controlling skill/resource statements all be followed for the same subject, object, condition, unit and scope?',
    ['The complete relevant instructions and resources contain no mutually incompatible controlling statements.'],
    ['Two exact controlling statements cannot both be satisfied for the same subject and conditions. Provide both quotes and establish their shared scope; wording differences, extra detail and compatible thresholds are not contradictions.'],
    'Conflicting requirements make the result depend on which statement is followed.',
    'Reconcile the two controlling statements so the same situation has one compatible requirement.'),
  definition('SKL-AI-CLARITY', 'Clear Skill Purpose and Activation', skillNodes,
    'Do the stated purpose and activation guidance communicate an unambiguous, accurate task? Missing-field and formatting checks remain deterministic-owned.',
    ['The supplied purpose and activation guidance make the intended task and when to use it materially clear.'],
    ['Populated purpose or activation guidance is materially ambiguous or misleading, beyond missing-field or format issues.'],
    'Ambiguous activation can select the wrong skill for a request.',
    'Clarify the specific purpose and activation boundary using the actual task and supported inputs.'),
  definition('SKL-AI-ACTIONABILITY', 'Executable Skill Steps', skillNodes,
    'Are the required inputs, decisions, ordering and outputs executable from the stated workflow? Capability absence belongs to SKL-09 and external prerequisite defects belong to SKL-AI-PREREQUISITES.',
    ['Required steps define the inputs, decisions, ordering and observable outputs needed to follow the supplied workflow.'],
    ['A required step lacks an executable input, decision, ordering or output contract, and the defect is not the same missing capability or external prerequisite claimed by another rule.'],
    'An underspecified required step forces the agent to guess how to perform the task.',
    'Specify the missing input, decision, sequence or expected output for that exact step.'),
  definition('SKL-AI-SCOPE', 'Focused Skill Responsibilities', skillNodes,
    'Do the skill responsibilities serve its stated primary task and, when bound, its supplied parent remit?',
    ['The responsibilities materially support the declared primary task and supplied remit.'],
    ['The skill adds materially unrelated responsibilities outside its stated primary task.'],
    'Unrelated responsibilities make activation and task ownership less predictable.',
    'Remove or separate the unrelated responsibility, or explicitly clarify the supported primary task.'),
  definition('SKL-AI-COMPOSABILITY', 'Explicit Invocation State', skillNodes,
    'Can the skill be reused without undeclared invocation or session state? An explicit cross-skill dependency claim in a Copilot set belongs to XSK-05.',
    ['Necessary invocation/session state is declared, supplied or initialized by the documented skill contract.'],
    ['Successful reuse relies on undeclared invocation/session state, apart from a cross-skill dependency owned by XSK-05.'],
    'Hidden state makes a skill behave differently across sessions or invocation order.',
    'Declare and validate the state as an input, or initialize it within this invocation.'),
  definition('SKL-AI-RESOURCE-ALIGNMENT', 'Resources Support Their Declared Role', skillNodes,
    'Does the actual readable resource content support the role the skill assigns it? A filename, omitted excerpt or deterministic orphan-file issue is not semantic evidence; direct contradictions belong to SKL-10.',
    ['Each relevant supplied resource materially supports its declared role in the skill.'],
    ['The actual resource content materially fails to serve the role assigned by the skill, without duplicating SKL-10 or a deterministic orphan-file claim.'],
    'A mismatched resource cannot reliably support the workflow that depends on it.',
    'Align the resource content with its declared role or change the referring step to use a suitable resource.',
    ['A complete manifest proves there are no resources assigned a role to assess.']),
  definition('SKL-AI-PREREQUISITES', 'Declared External Prerequisites', skillNodes,
    'Are evidenced required external inputs and configuration dependencies documented and supported by the declared contract? A legitimate documented dependency is not itself a defect.',
    ['The contract documents and supports each evidenced required external input or configuration dependency.'],
    ['An evidenced required external input or configuration dependency is undocumented or unsupported by the declared contract; do not duplicate an explicit missing-capability claim.'],
    'An undisclosed or unsupported prerequisite prevents the documented workflow from being followed.',
    'Document the exact prerequisite and how the caller supplies or configures it, or remove the unsupported dependency.'),
  definition('SKL-AI-OPERATIONAL-GUARDRAILS', 'Bounded Side-Effect Instructions', skillNodes,
    'Do semantic instructions bound material side effects with the scope, approval and recovery required by the supplied workflow? Code that executes or uses a network is not by itself a second semantic defect; scanner-owned patterns keep their own rule.',
    ['The supplied semantic side-effect instructions state the applicable scope, approval and recovery boundaries.'],
    ['The semantic instructions authorize an evidenced material side effect without a required scope, approval or recovery boundary. Identify the actual requirement; do not invent product or runtime policies.'],
    'An unbounded authorized side effect can change the wrong target or leave the user unable to recover.',
    'State the exact authorized target/scope, required approval and bounded recovery behavior for that operation.',
    ['The complete relevant scope establishes no material side-effect operation requiring this criterion.']),
];

const crossSkillDefinitions: ValidationRuleDefinition[] = [
  definition('XSK-01', 'Distinct Skill Routing Boundaries', ['cross-skill'],
    'Can one realistic supported user intent ambiguously select two skills because their routing boundaries do not distinguish ownership?',
    ['The complete supplied skill set has materially distinguishable routing boundaries for supported intents.'],
    ['Two skills support the same realistic intent and their supplied boundaries leave ownership ambiguous. Cite exactly those two skills; shared words alone are insufficient.'],
    'Ambiguous route ownership makes the selected behavior unpredictable.',
    'Differentiate the two activation boundaries or consolidate the genuinely overlapping task.',
    ['The complete eligible set contains fewer than two skills.']),
  definition('XSK-02', 'Distinct Skill Value', ['cross-skill'],
    'Does each skill contribute a meaningful capability or boundary rather than duplicate another?',
    ['Skills provide distinct value or an explicit meaningful difference within the complete declared set.'],
    ['Two supplied skills deliver the same capability without meaningful distinct value. Cite exactly the two skills and the duplicated responsibility.'],
    'Redundant skills add competing choices without adding capability coverage.',
    'Consolidate the duplicate responsibility or establish a meaningful distinct boundary.',
    ['The complete eligible set contains fewer than two skills.']),
  definition('XSK-03', 'Compatible Cross-Skill Guidance', ['cross-skill'],
    'Do controlling statements in different skills agree for the same subject and situation?',
    ['The complete set has compatible controlling guidance for shared subjects and conditions.'],
    ['Two skills give incompatible controlling instructions for the same subject, condition and scope. Cite both exact statements and only the two involved skills.'],
    'The same request can produce conflicting behavior depending on routing.',
    'Reconcile the two instructions into one compatible policy for that situation.',
    ['The complete eligible set contains fewer than two skills.']),
  definition('XSK-04', 'Declared Orchestration Coverage', ['cross-skill'],
    'Are the responsibilities required by the declared skill-orchestration design covered by the supplied skills or other configured routes?',
    ['Every responsibility required by the supplied design has a supported owner among the declared skills, tools or connected agents.'],
    ['An evidenced responsibility required by the declared skill-orchestration design has no supported owner in the complete supplied configuration. Do not require a skill for work intentionally owned by a tool or connected agent.'],
    'An unowned required responsibility leaves a supported request without its intended route.',
    'Assign the evidenced responsibility to a supported route, or explicitly change the declared supported scope.'),
  definition('XSK-05', 'Supported Cross-Skill Dependencies', ['cross-skill'],
    'Are dependencies on another skill input, prior output or side effect explicit and supported?',
    ['Cross-skill dependencies are explicit and supported by the documented inputs, outputs and ordering.'],
    ['A skill implicitly or unsupportably relies on another skill having produced an output or side effect. Cite exactly the dependent skill and its required provider; do not infer dependency from shared terminology.'],
    'An implicit dependency makes success depend on invocation order or hidden state.',
    'Declare and supply the dependency through supported inputs and ordering, or make the dependent skill self-contained.',
    ['The complete eligible set contains fewer than two skills.']),
  definition('XSK-06', 'Consistent Meaningful Skill Conventions', ['cross-skill'],
    'Do skill conventions remain consistent where a difference would establish an actual quality problem?',
    ['The complete set uses compatible conventions where consistency matters to its documented workflow.'],
    ['Inconsistent meaningful conventions establish an evidenced quality problem with a concrete correction. Mere style preferences and neutral observations are not defects.'],
    'Meaningfully inconsistent conventions make the declared workflow harder to follow reliably.',
    'Align the specific conflicting convention that causes the evidenced workflow problem.',
    ['The complete eligible set contains fewer than two skills.']),
];

export const VALIDATION_RULES: readonly ValidationRuleDefinition[] = [
  ...standardDefinitions(),
  ...instructionDefinitions,
  definition('INS-07', 'Instruction Capability Alignment', ['copilot-instructions'],
    capabilityQuestion, capabilityPass, capabilityFail,
    'A directive naming an unavailable capability cannot be followed on the captured agent.',
    'Use the actual configured capability identity or supply the missing capability on this agent.',
    ['The complete instruction field is empty and INS-01 owns the missing-instructions condition.']),
  ...crossSkillDefinitions,
  ...sharedSkillDefinitions,
];

export const VALIDATION_RECORD_IDS: ReadonlySet<string> = new Set([
  'KNW-04', 'MDL-01', 'KNW-01', 'TOL-01', 'CON-04', 'LCY-01', 'LCY-02', 'EVL-03', 'EVL-06',
]);

export function validationRule(id: string, kind: NodeKind): ValidationRuleDefinition {
  const found = VALIDATION_RULES.find(rule => rule.id === id && rule.nodes.includes(kind));
  if (!found) throw new Error(`The pinned ${kind} validation catalog does not contain ${id}.`);
  return found;
}

/** `why`/`fix`/`passWhen` are deliberately withheld from the node, so host-side readers of that
 * catalog prose resolve it here rather than from the request the node receives. */
export function validationRuleContract(id: string): RuleContract | undefined {
  return VALIDATION_RULES.find(rule => rule.id === id)?.contract;
}

export function validationProfile(kind: NodeKind, subjectIds: readonly string[]): ValidationProfile {
  return {
    kind,
    subjectIds: new Set(subjectIds),
    recordIds: VALIDATION_RECORD_IDS,
    rules: new Map(VALIDATION_RULES.filter(rule => rule.nodes.includes(kind))
      .map(rule => [rule.id, { execution: rule.execution, rule: rule.contract }])),
  };
}
