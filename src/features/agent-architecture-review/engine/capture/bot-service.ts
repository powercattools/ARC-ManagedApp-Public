/**
 * Reads agents and their components from whichever environment authored them.
 *
 * This is the engine's replacement for ART's `BotService`. The two issue the same queries against
 * the same columns; they differ only in how they reach Dataverse. ART's version imports the
 * generated `BotsService` and `BotcomponentsService`, which bind to ART's app identity and its
 * registered data sources — importing it here would resolve to data sources this app does not have.
 * The transport is injected instead, so the same code serves the browser and a Node worker.
 *
 * It satisfies ART's {@link ConnectedAgentBotService}, which is the narrow slice
 * `loadConnectedAgentMapSnapshotWith` needs. That is the whole reason connected-agent discovery is
 * reusable at all: ART takes the bot service as a parameter rather than importing the singleton.
 */

import type { EngineTransport, DataverseRow } from '../contracts/transport';
import type {
  BotComponent,
  BotComponentFetchOptions,
  BotSchemaMatch,
  ConnectedAgentBotService,
} from '../scoring/art-ports';
import { toComponent } from './component-row';

/**
 * Columns every review reads from `bots`.
 *
 * `configuration` is the agent's authored definition and the input the harness discriminant is
 * derived from, so it is never omitted to save bandwidth.
 */
const BOT_SELECT = 'botid,name,schemaname,configuration';

/**
 * Columns every review reads from `botcomponents`.
 *
 * Matches ART's selection exactly. `filedata_name` and `_parentbotcomponentid_value` look
 * incidental and are not: the first is how a skill's resource files are found, the second is how a
 * component is attributed to its parent skill.
 */
const COMPONENT_SELECT =
  'botcomponentid,name,description,componenttype,content,data,componentidunique,schemaname,' +
  'modifiedon,_parentbotcomponentid_value,filedata_name';

/**
 * Guard rather than escape.
 *
 * A quote would break out of the OData string literal. No legitimate Copilot Studio schema name
 * contains one, so a name that does is rejected instead of being made safe — quietly rewriting an
 * identifier would resolve the wrong agent.
 */
function assertQuotable(value: string, what: string): void {
  if (value.includes("'")) throw new Error(`${what} contains a quote and cannot be queried.`);
}

function text(row: DataverseRow, column: string): string | undefined {
  const value = row[column];
  return typeof value === 'string' ? value : undefined;
}

/**
 * A bot service bound to one environment.
 *
 * `orgUrl` arguments are accepted for signature compatibility with ART's `IBotService` and ignored:
 * routing to the authoring environment is the transport's job, and it already knows which
 * environment it was built for. Honouring the argument here would give two components of the same
 * review two different ideas of where the agent lives.
 */
export function createBotService(transport: EngineTransport): ConnectedAgentBotService {
  return {
    async getBotBySchemaName(schemaName: string): Promise<BotSchemaMatch | null> {
      const normalized = schemaName.trim();
      if (!normalized) throw new Error('Connected agent schema name is required.');
      assertQuotable(normalized, 'Connected agent schema name');

      // `componentstate eq 0` keeps unpublished and deleted solution layers out. Without it a
      // retired draft of the same schema name can win the sort and be reviewed instead.
      const filter =
        `schemaname eq '${normalized}' and statecode eq 0 and componentstate eq 0`;
      const rows = await transport.rows(
        `bots?$select=${BOT_SELECT}&$filter=${encodeURIComponent(filter)}&$orderby=modifiedon desc`,
        2,
      );

      const row = rows[0];
      if (!row) return null;

      const botId = text(row, 'botid');
      if (!botId) return null;

      return {
        botId,
        name: text(row, 'name') ?? normalized,
        schemaName: text(row, 'schemaname') ?? normalized,
        configuration: text(row, 'configuration') ?? '',
      } as BotSchemaMatch;
    },

    async getBotComponents(
      botId: string,
      _orgUrl?: string | null,
      options?: BotComponentFetchOptions,
    ): Promise<BotComponent[]> {
      try {
        assertQuotable(botId, 'Agent id');
        const filter = `_parentbotid_value eq ${botId}`;
        const rows = await transport.rows(
          `botcomponents?$select=${COMPONENT_SELECT}&$filter=${encodeURIComponent(filter)}&$orderby=name asc`,
        );
        return rows.map(toComponent);
      } catch (error) {
        // ART's contract: components are optional unless the caller insists. A connected agent that
        // cannot be read must fail loudly — it would otherwise be scored as an empty agent, which
        // produces a plausible number from no evidence.
        if (options?.throwOnError) throw error;
        console.error(`[ArchitectureReview] Could not load components for agent ${botId}.`, error);
        return [];
      }
    },
  };
}
