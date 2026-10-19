/** Typed parse model of a GitHub Copilot agent (spec 013 §3). */
export interface AeAgentSettings {
  instructions: string;
  modelSeries?: string;           // e.g. 'Sonnet46'
  enableWebSearch?: boolean;
  enableMemory?: boolean;
  raw: Record<string, unknown>;
}

export interface AeComponentIdentity {
  componentId?: string;
  componentIdUnique?: string;
}

export interface AeTool extends AeComponentIdentity {
  name: string; displayName?: string; description?: string;
  kind: 'ConnectorTool' | 'McpTool';
  authMode?: string; connectionReference?: string; connectorId?: string; operationId?: string;
  schemaname: string;
}
export interface AeSkill {
  name: string; schemaname: string;
  /** raw markdown from InlineAgentSkill.content */
  markdown: string;
  frontmatterName?: string; frontmatterDescription?: string; body: string;
  /** botcomponentid of the parent type-9 BotComponent */
  componentId: string;
  /** componentidunique of the parent type-9 BotComponent */
  componentIdUnique: string;
  /** "zip-bundle" when content is a bic:bundle marker; "inline-markdown" otherwise */
  source: "inline-markdown" | "zip-bundle";
  /** bic:bundle marker value, present only for zip-bundle skills */
  bundleMarker?: string;
  /** SHA-256 of the assembled bundle; set after bundle assembly */
  bundleHash?: string;
  /** Number of supporting resources; set after bundle assembly */
  resourceCount: number;
}
export interface AeConnectedAgent extends AeComponentIdentity {
  name: string; displayName?: string; description?: string;
  botSchemaName?: string; historyTypeKind?: string; schemaname: string;
}
export interface AeKnowledgeSource extends AeComponentIdentity {
  name: string;
  sourceKind?: string;
  schemaname: string;
}
/**
 * A grader configured on an evaluation set, retaining the settings that
 * distinguish two graders of the same kind (e.g. CompareMeaningGrader at
 * thresholds 0.6 and 0.3) and whether it carries enough config to return a
 * verdict at all.
 */
export interface AeGrader {
  kind: string;
  /** ToolCallGrader: the tool it expects to see called. PromptGrader: maker-supplied name. */
  name?: string;
  /** CompareMeaningGrader similarity threshold (0..1). */
  threshold?: number;
  /** False when the grader kind requires configuration and none is present. */
  configured: boolean;
  /** PromptGrader rubric text. */
  instructions?: string;
  /** PromptGrader outcome labels. */
  labels?: { name: string; description?: string; outcome?: string }[];
}
export interface AeEvaluationSet extends AeComponentIdentity {
  name: string; displayName?: string; graders: string[];
  /** Optional: absent on reviews persisted before grader detail was captured. */
  graderDetails?: AeGrader[];
  /** botcomponentid, used to link test cases to their set. */
  id?: string;
  schemaname: string;
}
/** A capability a test case declares it expects the agent to invoke. */
export interface AeExpectedStep { kind: string; schemaName: string }
export interface AeTestCase extends AeComponentIdentity {
  name: string; input?: string; expected?: string; schemaname: string;
  /** User-turn count. Optional: absent on reviews persisted before turn capture. */
  turns?: number;
  /** True when parsed from a MultiTurnEvaluationCase component. */
  multiTurn?: boolean;
  /** Capabilities the case declares it should invoke. Only conversation cases carry these. */
  expectedTools?: AeExpectedStep[];
  /** Keywords the agent's response is expected to contain. */
  expectedKeywords?: string[];
  /** 'Manual' when hand-authored, 'Generated' when AI-authored. */
  source?: string;
  /** botcomponentid of the owning evaluation set. */
  setId?: string;
}
export interface AeMultiTurnCase { name: string; schemaname: string; }
/**
 * A standard-harness topic (`AgentDialog` / dialog component).
 *
 * Topics are what a standard agent routes over, so they occupy the same scoring slot
 * that skills occupy for a copilot agent. The copilot parser never emits these.
 */
export interface AeTopic extends AeComponentIdentity {
  name: string;
  schemaname: string;
  description?: string;
}
export interface AeTrigger extends AeComponentIdentity {
  name: string;
  kind?: string;
  schemaname: string;
  flowId?: string;
}
export interface AeUnknownKind extends AeComponentIdentity {
  schemaname: string;
  kind?: string;
  componenttype: string;
  warning: string;
}

export interface AgentsExperienceModel {
  agentSettings: AeAgentSettings;
  tools: AeTool[]; skills: AeSkill[]; connectedAgents: AeConnectedAgent[];
  knowledge: AeKnowledgeSource[]; evaluationSets: AeEvaluationSet[];
  testCases: AeTestCase[]; multiTurnCases: AeMultiTurnCase[];
  triggers: AeTrigger[]; unknownKinds: AeUnknownKind[];
  /**
   * Sub-agents defined inside this agent (`AgentDialog` components), as opposed to
   * `connectedAgents`, which call out to a separate agent. Standard agents can have
   * either or both; the copilot harness only ever produces `connectedAgents`, so this
   * is optional and absent there.
   */
  childAgents?: AeConnectedAgent[];
  /**
   * Topics this agent routes over. Standard-harness only, and the population behind the
   * pillar the standard harness labels "Topics" and the copilot harness labels "Skills".
   */
  topics?: AeTopic[];
}
