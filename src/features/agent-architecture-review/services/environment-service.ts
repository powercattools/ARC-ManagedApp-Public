/**
 * Environment and agent pickers for the create dialog — backed by Dataverse.
 *
 * Mirrors the Agent Review Tool (see
 * `specs/015-architectural-workbench/context/agent-review-tool-env-logic.md`):
 *
 *   environments -> MicrosoftDataverseService.GetOrganizations()
 *   agents       -> ListRecordsWithOrganization(orgUrl, 'bots', ...)
 *
 * One deliberate divergence from ART:
 *
 * 1. **All active agents are returned.** ART additionally filters to
 *    `configuration.settings.GenerativeActionsEnabled`, because its rubric only
 *    applies to generative-orchestration agents. We list everything (FR-086a),
 *    which also avoids ART's silent drop of agents whose `configuration` is
 *    missing or unparseable.
 *
 * **No role check runs against any environment**, matching ART exactly. ART's
 * only role code (`power-shield/shared/services/dataverse/authService.ts`) reads
 * the *app's own* environment to choose navigation; nothing role-checks the
 * environment being reviewed, and it could not — those calls use generated
 * services with no `organization` header.
 *
 * Dataverse enforces access server-side on every call, so a client-side gate
 * could only ever be a second, weaker opinion. The one we had refused users who
 * held access through a team-granted role — it read `systemuserroles_association`,
 * which returns direct assignments only — or through any role we had not named.
 * A user without access now sees the read itself fail, as they do in ART.
 */

import { MicrosoftDataverseService } from '../../../data';

export interface EnvironmentOption {
  /** Organization URL — the value passed as the `organization` header. */
  url: string;
  friendlyName: string;
}

export interface AgentOption {
  botId: string;
  name: string;
  /** Source of the agent icon in the landing grid's Name column (FR-078). */
  iconBase64?: string;
}

interface OrganizationRecord {
  Url?: string;
  FriendlyName?: string;
}

interface BotRecord {
  botid?: string;
  name?: string;
  iconbase64?: string;
}

/** The connector returns loosely typed payloads; narrow them at the boundary. */
function valuesOf<T>(result: unknown): T[] {
  const data = (result as { data?: { value?: T[] } } | undefined)?.data;
  return Array.isArray(data?.value) ? data.value : [];
}

/**
 * A failed call is a fault, not an empty result.
 *
 * `valuesOf` cannot tell them apart, so without this a user denied access to an
 * environment would be told it holds no agents — the read is exactly how they
 * are meant to discover they lack access, now that nothing role-checks up front.
 */
function ensureSucceeded(result: { success?: boolean; error?: { message?: string } }, what: string): void {
  if (result.success) return;
  throw new Error(result.error?.message ?? `Could not read ${what}.`);
}

/**
 * Leading arguments for the `…WithOrganization` operations:
 * `prefer`, `accept`, `x-ms-odata-metadata-full`, `MSCRM.IncludeMipSensitivityLabel`.
 *
 * Every one must be an explicit value — never `undefined`. The Power Apps data
 * client serialises an omitted argument into the header as the literal string
 * `"undefined"`, which makes the connector policy fail `Boolean.Parse` and
 * return HTTP 500 ("String was not recognized as a valid Boolean").
 */
const ODATA_HEADER_DEFAULTS = ['', 'application/json', false, false] as const;

export const environmentService = {
  /** Every environment the connection can reach, sorted by name. */
  async listEnvironments(): Promise<EnvironmentOption[]> {
    const result = await MicrosoftDataverseService.GetOrganizations();
    ensureSucceeded(result, 'the environment list');

    return valuesOf<OrganizationRecord>(result)
      .map((org) => ({
        url: org.Url ?? '',
        // GetOrganizations includes a `current` sentinel with no friendly name.
        friendlyName:
          org.FriendlyName ||
          (org.Url?.toLowerCase() === 'current' ? 'Current environment' : org.Url) ||
          'Unknown',
      }))
      .filter((org) => org.url !== '')
      .sort((a, b) => a.friendlyName.localeCompare(b.friendlyName));
  },

  /**
   * Active agents in one environment.
   *
   * Omitting `environmentUrl` returns nothing rather than fanning out across
   * every environment: cross-organization search is not in Phase 1 (OQ-31), and
   * the caller prompts the user to pick an environment first.
   *
   * No role check precedes this. If the user cannot read `bots` in the chosen
   * environment, this call fails and the dialog says so.
   *
   * `botcomponents` is probed alongside it. The review reads both tables
   * (`connector-transport.ts`), but only from the engine, long after the dialog
   * has closed — so without this probe a user who can read agents but not their
   * components creates a snapshot and discovers the problem mid-review. ART does
   * not probe it either; catching it here costs one `$top=1` read.
   */
  async listAgents(environmentUrl?: string): Promise<AgentOption[]> {
    if (!environmentUrl) return [];

    const [botResult, componentResult] = await Promise.all([
      MicrosoftDataverseService.ListRecordsWithOrganization(
        environmentUrl,
        'bots',
        ...ODATA_HEADER_DEFAULTS,
        'botid,name,iconbase64',
        'statecode eq 0',
        'name asc',
      ),
      MicrosoftDataverseService.ListRecordsWithOrganization(
        environmentUrl,
        'botcomponents',
        ...ODATA_HEADER_DEFAULTS,
        'botcomponentid',
        undefined,
        undefined,
        undefined,
        undefined,
        1,
      ),
    ]);

    // Agents first: a user who can read neither table should hear about the one
    // the picker is visibly trying to fill.
    ensureSucceeded(botResult, 'agents in this environment');
    ensureSucceeded(componentResult, 'agent components in this environment');

    return valuesOf<BotRecord>(botResult)
      .filter((bot) => bot.botid !== undefined)
      .map((bot) => ({
        botId: bot.botid as string,
        name: bot.name ?? '(unnamed agent)',
        iconBase64: bot.iconbase64,
      }));
  },
};
