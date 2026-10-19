/**
 * Agent -> capture. Reads one agent's configuration, components and — for a copilot agent — its
 * skill bundles from whichever environment authored it.
 *
 * This is the input every review starts from, whichever harness scores it, and it is deliberately a
 * separate step from reviewing. A capture is what makes a snapshot comparable: two snapshots of the
 * same agent differ because their captures differ, not because the two runs read Dataverse at
 * different moments and disagreed about what the agent was.
 *
 * Browser-safe. No `Buffer`, no `process`, no generated Dataverse client — see `engine/README.md`.
 */

import type { EngineTransport, DataverseRow } from '../contracts/transport';
import {
  assembleSkillBundle,
  normalizeResource,
  parseAgentDescription,
  parseAgentSettings,
  parseAgentsExperience,
  usesCopilotHarness,
  type AgentSettings,
  type AgentsExperienceModel,
  type BotComponent,
  type SkillBundle,
} from '../scoring/art-ports';
import { toComponent } from './component-row';

/** Columns a review reads from `bots`. */
const BOT_SELECT =
  'botid,name,schemaname,configuration,componentidunique,publishedon,modifiedon,' +
  'applicationmanifestinformation,language,authenticationmode';

/** Columns a review reads from `botcomponents`. Mirrors ART's selection exactly. */
const COMPONENT_SELECT =
  'botcomponentid,name,description,componenttype,content,data,componentidunique,schemaname,' +
  'modifiedon,_parentbotcomponentid_value,_parentbotid_value,filedata_name';

/** Columns read for a skill's attached resource files. */
const RESOURCE_SELECT =
  'botcomponentid,name,componenttype,componentidunique,schemaname,filedata_name,modifiedon,' +
  '_parentbotcomponentid_value,_parentbotid_value';

/** File-attachment components. Their content lives in `filedata`, not in `content` or `data`. */
const RESOURCE_COMPONENT_TYPE = '14';

/** Fields every capture carries, whichever harness authored the agent. */
interface CapturedAgentBase {
  botId: string;
  botName: string;
  schemaName: string;
  componentIdUnique?: string;
  /** Published version stamp, so a snapshot records which build of the agent it graded. */
  agentVersion?: string;
  configuration: string;
  /**
   * The agent's own description and settings, read the way the Agent Review Tool reads them.
   *
   * Both feed rules — description clarity, language, authentication mode, the AI settings — so a
   * capture that omitted them would not be scored leniently, it would be scored as an agent that
   * genuinely has no description and no settings configured.
   */
  agentDescription?: string;
  agentSettings?: AgentSettings;
  components: BotComponent[];
  /** Environment the agent was read from. */
  organization: string;
}

/** A copilot (agents-experience) agent: the parsed model and the assembled skill bundles. */
export interface CopilotAgentCapture extends CapturedAgentBase {
  harness: 'copilot';
  model: AgentsExperienceModel;
  bundles: SkillBundle[];
}

/**
 * A standard (classic) agent: raw components and nothing else.
 *
 * `parseAgentsExperience` would find no agents-experience configuration to read, and skills are a
 * copilot concept. A classic agent's behaviour lives in its topics and `AgentDialog` components,
 * which `extractStandardSnapshot` reads straight out of `components`.
 */
export interface StandardAgentCapture extends CapturedAgentBase {
  harness: 'standard';
}

/**
 * One agent, as captured.
 *
 * A union rather than optional fields, because `model` and `bundles` are not "sometimes missing" —
 * they are meaningless for a standard agent. A type that admitted reading them would let a standard
 * code path compile against data that can never exist at runtime.
 */
export type AgentCapture = CopilotAgentCapture | StandardAgentCapture;

function text(row: DataverseRow, column: string): string | undefined {
  const value = row[column];
  return typeof value === 'string' ? value : undefined;
}

function required(row: DataverseRow, column: string, what: string): string {
  const value = text(row, column);
  if (!value) throw new Error(`${what} is missing from the captured agent.`);
  return value;
}

/** Option-set columns arrive as numbers, but a widened row type cannot promise that. */
function number(row: DataverseRow, column: string): number | undefined {
  const value = row[column];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Guard rather than escape — a quote would break out of the OData literal, and no legitimate
 * Dataverse id contains one.
 */
function guard(value: string, what: string): string {
  if (!/^[0-9a-fA-F-]{36}$/.test(value)) throw new Error(`${what} is not a Dataverse id.`);
  return value;
}

/**
 * Download and assemble every skill bundle for a copilot agent.
 *
 * The expensive half of a capture: every skill's attached files are downloaded so the rubric can
 * read them. That cost is why bundles are assembled once, here, and then reused by both the
 * deterministic scan and the AI stage rather than being re-fetched per stage.
 */
async function assembleBundles(
  transport: EngineTransport,
  id: string,
  model: AgentsExperienceModel,
  signal?: AbortSignal,
): Promise<SkillBundle[]> {
  const bundles: SkillBundle[] = [];
  for (const skill of model.skills) {
    if (signal?.aborted) throw new Error('Review cancelled');
    if (!skill.componentId) continue;
    const parentId = guard(skill.componentId, 'Skill component id');

    // Only published, active resource layers. An unpublished draft of the same file would otherwise
    // be graded instead of the version the agent actually runs.
    const filter =
      `_parentbotcomponentid_value eq ${parentId} and _parentbotid_value eq ${id} ` +
      `and componenttype eq ${RESOURCE_COMPONENT_TYPE} and componentstate eq 0 ` +
      `and statecode eq 0 and statuscode eq 1`;
    const resourceRows = await transport.rows(
      `botcomponents?$select=${RESOURCE_SELECT}` +
        `&$filter=${encodeURIComponent(filter)}` +
        `&$orderby=botcomponentid asc`,
      1_000,
    );

    const resources: Awaited<ReturnType<typeof normalizeResource>>[] = [];
    for (const row of resourceRows) {
      if (signal?.aborted) throw new Error('Review cancelled');
      const resourceId = guard(required(row, 'botcomponentid', 'Resource id'), 'Resource id');
      const bytes = await transport.file(`botcomponents(${resourceId})/filedata/$value`);
      resources.push(await normalizeResource(row as never, bytes));
    }

    // The skill's own markdown is carried on the component as JSON, which is the shape the
    // assembler reads; it is rebuilt here rather than re-fetched because the parser already has it.
    const data = JSON.stringify({ content: skill.markdown });
    bundles.push(
      await assembleSkillBundle(
        {
          botcomponentid: parentId,
          botid: id,
          componenttype: '9',
          content: data,
          data,
          name: skill.name,
          componentidunique: skill.componentIdUnique,
          schemaname: skill.schemaname,
        } as never,
        resources,
        {
          agentInstructions: model.agentSettings.instructions,
          siblingDescriptions: model.skills
            .filter((other) => other.schemaname !== skill.schemaname)
            .map((other) => ({
              name: other.frontmatterName ?? other.name,
              description: other.frontmatterDescription,
            })),
        },
      ),
    );
  }

  return bundles;
}

/**
 * Capture one agent.
 *
 * The harness is read from the agent's own configuration, never supplied by the caller: a
 * mislabelled capture would be graded by the wrong rubric and produce a number that looks valid and
 * is not. Both harnesses freeze the same raw material — the bot row and its components — so a
 * snapshot always scores the bytes it captured, not whatever the agent has become since.
 *
 * @param transport - Bound to the environment that authored the agent.
 * @param botId - Agent to capture.
 * @param signal - Abort signal; capture is the longest cancellable phase of a review.
 */
export async function captureAgent(
  transport: EngineTransport,
  botId: string,
  signal?: AbortSignal,
): Promise<AgentCapture> {
  const id = guard(botId, 'Agent id');

  const bot = (await transport.get(`bots(${id})?$select=${BOT_SELECT}`)) as DataverseRow | undefined;
  if (!bot || typeof bot !== 'object') throw new Error(`Agent ${id} could not be read.`);

  const configuration = required(bot, 'configuration', 'Agent configuration');
  const agentDescription = parseAgentDescription(text(bot, 'applicationmanifestinformation'));

  const componentRows = await transport.rows(
    `botcomponents?$select=${COMPONENT_SELECT}` +
      `&$filter=${encodeURIComponent(`_parentbotid_value eq ${id}`)}` +
      `&$orderby=${encodeURIComponent('name asc,botcomponentid asc')}`,
    5_000,
  );
  if (signal?.aborted) throw new Error('Review cancelled');

  const base = {
    botId: id,
    botName: text(bot, 'name') ?? id,
    schemaName: text(bot, 'schemaname') ?? '',
    componentIdUnique: text(bot, 'componentidunique'),
    agentVersion: text(bot, 'publishedon'),
    configuration,
    ...(agentDescription === undefined ? {} : { agentDescription }),
    agentSettings: parseAgentSettings(
      number(bot, 'language'),
      number(bot, 'authenticationmode'),
      configuration,
    ),
    components: componentRows.map(toComponent),
    organization: transport.organization,
  };

  // A standard agent stops here. Its child agents are `AgentDialog` components inside this same bot
  // rather than separate agents, so `components` already holds everything its rubric reads.
  if (!usesCopilotHarness(configuration)) return { ...base, harness: 'standard' };

  const model = parseAgentsExperience(configuration, base.components);
  return {
    ...base,
    harness: 'copilot',
    model,
    bundles: await assembleBundles(transport, id, model, signal),
  };
}
