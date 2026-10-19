/**
 * Readiness checks for the Setup surface (FR-029 to FR-037).
 *
 * Everything here reads from Dataverse through the `…WithOrganization`
 * operations, so the same code answers for the current environment
 * (`organization: 'current'`) or any environment the user administers.
 *
 * Why not the Power Platform API
 * ------------------------------
 * The two transcript settings are the reason this surface exists, and
 * `api.powerplatform.com/environmentmanagement` does not expose them — its
 * documented schema stops at `copilotStudio_ConnectedAgents` and
 * `copilotStudio_ConversationAuditLoggingEnabled`, neither of which is the
 * transcript toggle. It is also unreachable from a code app: there is no way to
 * acquire an `api.powerplatform.com/.default` token from the Power Apps SDK, and
 * the endpoint does not answer CORS for the player origin. Routing it through a
 * custom connector or a flow HTTP action would work but drags in DLP scope and
 * premium licensing.
 *
 * Both settings turn out to live on the Dataverse `organization` row, which this
 * app can already read — no new connector, no DLP surface:
 *
 *   blocktranscriptrecordingforcopilotstudio        -> "save transcripts in Dataverse"
 *   blockaccesstosessiontranscriptsforcopilotstudio -> "owners/editors can see transcripts"
 *
 * Both are **inverted**: `true` means the feature is blocked.
 *
 * These reflect the environment-level selection. An environment-group rule can
 * override it without changing this row, so a passing check links out to PPAC
 * rather than claiming to be the last word.
 */

import { MicrosoftDataverseService, getHostContext } from '../../../data';
import { isCurrentEnvironment } from './art-service';
import {
  CHECK_TITLES,
  type CheckDraft,
  type CheckItem,
  type HomeEnvironment,
  type SetupSummary,
  summarise,
} from '../models/setup';

/** Sentinel accepted by the connector for the environment the app runs in. */
export const CURRENT_ORGANIZATION = 'current';

/** The Agents reference the `Review Agent Components` flow runs under. */
const AGENT_CONNECTION_REFERENCE = 'cat_CopilotStudioAcceleratorAgent';

/** The flow that produces component scores for a reviewed agent. */
const AGENT_REVIEW_FLOW = 'Review Agent Components';

/**
 * Connection references to check when the installed flow cannot be read, by
 * logical name. Matching on logical name rather than display name because the
 * display name is editable and already varies across environments ("Agent
 * Review Tool | Agents" here), whereas the logical name is fixed by the
 * solution.
 *
 * Only a fallback. Which Dataverse reference the flow binds depends on which
 * package installed it, so the real list is read from the flow itself — see
 * `flowConnectionReferences`. These names are what this app's own solution
 * ships, which is the right guess when there is nothing to read.
 */
const FALLBACK_CONNECTION_REFERENCES = [
  'new_sharedcommondataserviceforapps_99a44867',
  AGENT_CONNECTION_REFERENCE,
];

/**
 * Cloud flows the app requires. A named set rather than "every flow in the
 * solution" so that adding an unrelated flow later cannot silently start
 * blocking setup.
 */
const REQUIRED_FLOWS = [AGENT_REVIEW_FLOW];

/**
 * Roles that let someone run transcript analysis in the environment this app runs in.
 *
 * Any one of them is enough. A purpose-built role is planned — add its name here and nothing else
 * changes. `CSK - Administrator` is listed ahead of that so an environment which already has the
 * Copilot Studio Kit installed qualifies without extra setup.
 *
 * Only meaningful for the current environment. Other environments are judged on what the user can
 * actually read there, because a role name is a local fact: the same person holds different roles in
 * every environment, and Dataverse grants most of them through a team rather than directly.
 */
const TRANSCRIPT_ROLES = ['System Administrator', 'CSK - Administrator'] as const;

/**
 * `category eq 5` is a modern cloud flow and `type eq 1` its definition rather
 * than an activation copy — without both, activating hits the wrong row.
 */
const FLOW_BASE_FILTER = 'category eq 5 and type eq 1';

/** See `environment-service`: every header argument must be an explicit value. */
const HEADERS = ['', 'application/json', false, false] as const;

interface OrganizationRow {
  name?: string;
  organizationid?: string;
  blocktranscriptrecordingforcopilotstudio?: boolean;
  blockaccesstosessiontranscriptsforcopilotstudio?: boolean;
}

interface WorkflowRow {
  workflowid?: string;
  name?: string;
  statecode?: number;
  statuscode?: number;
  clientdata?: string;
}

interface ConnectionReferenceRow {
  connectionreferenceid?: string;
  connectionreferencedisplayname?: string;
  connectionreferencelogicalname?: string;
  connectionid?: string;
  connectorid?: string;
}

interface NamedRow {
  name?: string;
}

interface SystemUserRow {
  systemuserid?: string;
}

function valuesOf<T>(result: unknown): T[] {
  const data = (result as { data?: { value?: T[] } } | undefined)?.data;
  return Array.isArray(data?.value) ? data.value : [];
}

function odataLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/** `or`-joins an equality filter over a list of string literals. */
function anyOf(field: string, values: readonly string[]): string {
  return values.map((value) => `${field} eq '${odataLiteral(value)}'`).join(' or ');
}

async function list<T>(
  organization: string,
  entityName: string,
  select: string,
  filter?: string,
  top?: number,
): Promise<T[]> {
  const result = await MicrosoftDataverseService.ListRecordsWithOrganization(
    organization,
    entityName,
    ...HEADERS,
    select,
    filter,
    undefined,
    undefined,
    undefined,
    top,
  );

  if (!result.success) throw new Error(describeError(result));
  return valuesOf<T>(result);
}

function describeError(result: { error?: unknown; data?: unknown }): string {
  const raw = result.error ?? result.data;
  if (typeof raw === 'object' && raw !== null) {
    const outer = raw as { message?: string; error?: { message?: string } };
    if (outer.error?.message) return outer.error.message;
    if (outer.message) return outer.message;
  }
  return 'The environment did not answer.';
}

/** The connector's display label for the environment currently being checked. */
function environmentLabel(organization: string, organizationName?: string): string {
  if (organizationName) return organizationName;
  return organization === CURRENT_ORGANIZATION ? 'the current environment' : organization;
}

/**
 * Appends where a global setting actually lives, but only when that is not
 * where the reader is looking.
 *
 * Without this the connections and flows cards read identically no matter which
 * environment is selected, which is exactly the confusion that made them look
 * per-environment in the first place.
 */
function scopeNote(detail: string, homeLabel: string, isHome: boolean): string {
  return isHome ? detail : `${detail} Configured in ${homeLabel}, and shared by every environment.`;
}

async function readOrganization(organization: string): Promise<OrganizationRow> {
  const rows = await list<OrganizationRow>(
    organization,
    'organizations',
    'organizationid,name,blocktranscriptrecordingforcopilotstudio,blockaccesstosessiontranscriptsforcopilotstudio',
    undefined,
    1,
  );
  const row = rows[0];
  if (!row) throw new Error('The environment returned no organization record.');
  return row;
}

/**
 * PPAC deep link for the environment's Copilot Studio feature settings.
 *
 * Only resolvable for the current environment: PPAC addresses environments by
 * their Power Platform GUID, which the Dataverse `organization` row does not
 * carry (`microsoftflowenvironment` is empty in practice). For any other
 * environment the caller falls back to the environments list.
 */
async function adminSettingsUrl(organization: string): Promise<string> {
  const fallback = 'https://admin.powerplatform.microsoft.com/manage/environments';
  if (organization !== CURRENT_ORGANIZATION) return fallback;
  try {
    const context = await getHostContext();
    const environmentId = context.app.environmentId;
    return environmentId
      ? `https://admin.powerplatform.microsoft.com/manage/environments/${environmentId}/settings/features`
      : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Decides whether the environment being inspected is the one the app runs in,
 * and names that environment so the global cards can say where they live.
 *
 * Compares `organizationid` rather than the picker's value, because the app's
 * own environment also appears in the picker under its URL. Matching on the
 * `'current'` sentinel alone would make the global cards read-only whenever the
 * user selected their own environment by name — the one case where editing
 * should certainly be allowed.
 */
async function resolveHomeEnvironment(
  organization: string,
  target: OrganizationRow | undefined,
): Promise<HomeEnvironment> {
  const fallbackName = 'the environment this app is installed in';

  if (organization === CURRENT_ORGANIZATION) {
    return { isHome: true, name: target?.name ?? fallbackName };
  }

  try {
    const current = await readOrganization(CURRENT_ORGANIZATION);
    return {
      isHome: Boolean(current.organizationid) && current.organizationid === target?.organizationid,
      name: current.name ?? fallbackName,
    };
  } catch {
    // Without the home row there is nothing to compare against. Reporting "not
    // home" keeps the global cards read-only, which is the safe direction.
    return { isHome: false, name: fallbackName };
  }
}

// ─── individual checks ───────────────────────────────────────────────────────

function environmentCheck(organization: string, org: OrganizationRow): CheckDraft {
  return {
    id: 'environment',
    title: CHECK_TITLES.environment,
    status: 'pass',
    detail: `Environment: ${environmentLabel(organization, org.name)} · Dataverse responding`,
  };
}

async function copilotStudioCheck(organization: string, org: OrganizationRow): Promise<CheckDraft> {
  const label = environmentLabel(organization, org.name);
  try {
    const AGENT_SAMPLE_CAP = 200;
    const agents = await list<{ botid?: string }>(
      organization,
      'bots',
      'botid',
      'statecode eq 0',
      AGENT_SAMPLE_CAP,
    );
    const count = agents.length;
    const shown = count === AGENT_SAMPLE_CAP ? `${AGENT_SAMPLE_CAP}+` : `${count}`;

    if (count === 0) {
      return {
        id: 'copilot-studio',
        title: CHECK_TITLES['copilot-studio'],
        status: 'warning',
        detail: `Environment: ${label} · Copilot Studio provisioned, but no active agents found`,
        blocks: 'Nothing to review in this environment',
      };
    }

    return {
      id: 'copilot-studio',
      title: CHECK_TITLES['copilot-studio'],
      status: 'pass',
      detail: `Environment: ${label} · Copilot Studio enabled · ${shown} active agent${count === 1 ? '' : 's'}`,
    };
  } catch {
    // A missing `bot` table is how an environment without Copilot Studio fails.
    return {
      id: 'copilot-studio',
      title: CHECK_TITLES['copilot-studio'],
      status: 'fail',
      detail: `Environment: ${label} · Copilot Studio does not appear to be provisioned`,
      blocks: 'Blocks every review in this environment',
    };
  }
}

/**
 * Every role the user holds in one environment, including roles granted through a team.
 *
 * `systemuserroles_association` returns **direct** assignments only. Most Dataverse access arrives
 * through a team, so reading only that navigation reports "no roles" for users who plainly have
 * them — which is why the create dialog used to refuse environments the user could work in.
 *
 * The team half is best-effort: a user with no team memberships and a tenant that will not answer
 * this query look the same, and neither is a reason to discard the direct roles already read.
 */
async function rolesFor(organization: string, userId: string): Promise<string[]> {
  const direct = await list<NamedRow>(
    organization,
    `systemusers(${userId})/systemuserroles_association`,
    'name,roleid',
  );

  let viaTeams: NamedRow[] = [];
  try {
    const teams = await list<{ teamid?: string }>(
      organization,
      `systemusers(${userId})/teammembership_association`,
      'teamid',
    );
    const teamRoles = await Promise.all(
      teams
        .map((team) => team.teamid)
        .filter((id): id is string => Boolean(id))
        .map((id) => list<NamedRow>(organization, `teams(${id})/teamroles_association`, 'name,roleid')),
    );
    viaTeams = teamRoles.flat();
  } catch {
    viaTeams = [];
  }

  const names = [...direct, ...viaTeams].map((role) => role.name).filter(Boolean) as string[];
  return [...new Set(names)].sort((a, b) => a.localeCompare(b));
}

/**
 * Can the user do the work this environment is being checked for?
 *
 * The question differs by environment, because the app's reach does:
 *
 * - **The environment the app runs in** holds the plugin that reads conversation transcripts, so the
 *   check is whether the user has a role that permits transcript analysis.
 * - **Any other environment** is only ever read across the connector for a configuration review, so
 *   the check is whether `bots` and `botcomponents` can actually be read — the same two tables the
 *   review reads. No role is inspected: role names are local to an environment and say nothing that
 *   the read itself does not answer more accurately.
 *
 * Neither outcome blocks "every review" the way this check once claimed. Missing transcript rights
 * cost runtime analysis; unreadable agent tables cost reviews *in that environment* only.
 */
async function securityRoleCheck(organization: string, org: OrganizationRow): Promise<CheckDraft> {
  const label = environmentLabel(organization, org.name);
  const title = CHECK_TITLES['security-role'];
  const isCurrent = await isCurrentEnvironment(organization);

  if (!isCurrent) {
    try {
      await Promise.all([
        list<{ botid?: string }>(organization, 'bots', 'botid', undefined, 1),
        list<{ botcomponentid?: string }>(organization, 'botcomponents', 'botcomponentid', undefined, 1),
      ]);

      return {
        id: 'security-role',
        title,
        status: 'pass',
        detail: `You can read agents and their components in ${label}, which is all a configuration review needs.`,
        items: [
          { id: 'bots', label: 'Agents (bots)', status: 'pass', stateLabel: 'Readable' },
          { id: 'botcomponents', label: 'Agent components (botcomponents)', status: 'pass', stateLabel: 'Readable' },
        ],
      };
    } catch (error) {
      return {
        id: 'security-role',
        title,
        status: 'fail',
        detail: `Agents or their components could not be read in ${label}: ${
          error instanceof Error ? error.message : 'the environment did not answer.'
        }`,
        blocks: 'Blocks reviews in this environment',
      };
    }
  }

  let objectId: string | undefined;
  let fullName: string | undefined;
  try {
    const context = await getHostContext();
    objectId = context.user.objectId;
    fullName = context.user.fullName;
  } catch {
    objectId = undefined;
  }

  if (!objectId || !/^[0-9a-f-]{36}$/i.test(objectId)) {
    return {
      id: 'security-role',
      title,
      status: 'unknown',
      detail: 'Could not identify the signed-in user outside the managed app host.',
    };
  }

  try {
    // The managed app host reports the user's Entra object ID, not their sign-in name.
    const users = await list<SystemUserRow>(
      organization,
      'systemusers',
      'systemuserid',
      `azureactivedirectoryobjectid eq ${objectId}`,
      1,
    );
    const userId = users[0]?.systemuserid;

    if (!userId) {
      return {
        id: 'security-role',
        title,
        status: 'fail',
        detail: `${fullName ?? 'You'} has no user record in ${label}.`,
        blocks: 'Blocks runtime transcript analysis',
      };
    }

    const roleNames = await rolesFor(organization, userId);
    const qualifies = (name: string) => (TRANSCRIPT_ROLES as readonly string[]).includes(name);
    const qualifying = roleNames.filter(qualifies);

    const items: CheckItem[] = roleNames.map((name) => ({
      id: name,
      label: name,
      status: qualifies(name) ? 'pass' : 'unknown',
      stateLabel: qualifies(name) ? 'Qualifies' : undefined,
    }));

    return {
      id: 'security-role',
      title,
      // A warning, not a failure: configuration reviews run without any of these roles. Only the
      // transcript half of a snapshot depends on them.
      status: qualifying.length > 0 ? 'pass' : 'warning',
      detail:
        qualifying.length > 0
          ? `${fullName ?? 'You'} · ${qualifying.join(', ')} in ${label}`
          : `${fullName ?? 'You'} holds ${roleNames.length} role${roleNames.length === 1 ? '' : 's'} in ${label}, none of them ${TRANSCRIPT_ROLES.join(' or ')}. Configuration reviews still run.`,
      blocks: qualifying.length > 0 ? undefined : 'Blocks runtime transcript analysis',
      items,
    };
  } catch (error) {
    return {
      id: 'security-role',
      title,
      status: 'unknown',
      detail: error instanceof Error ? error.message : 'Could not read your roles.',
    };
  }
}

function transcriptRecordingCheck(
  organization: string,
  org: OrganizationRow,
  helpUrl: string,
): CheckDraft {
  const label = environmentLabel(organization, org.name);
  const blocked = org.blocktranscriptrecordingforcopilotstudio;

  if (blocked === undefined) {
    return {
      id: 'transcript-recording',
      title: CHECK_TITLES['transcript-recording'],
      status: 'unknown',
      detail: `This environment did not report the setting for ${label}.`,
      helpUrl,
      helpLabel: 'Check in the admin center',
    };
  }

  return {
    id: 'transcript-recording',
    title: CHECK_TITLES['transcript-recording'],
    status: blocked ? 'fail' : 'pass',
    detail: blocked
      ? `Environment setting: transcript recording is OFF for ${label}.`
      : `Environment setting: transcript recording is ON for ${label}. An environment-group rule can still override it.`,
    blocks: blocked ? 'Blocks runtime analysis, credit estimation' : undefined,
    helpUrl,
    helpLabel: blocked ? 'Turn on in the admin center' : 'Verify in the admin center',
  };
}

function transcriptViewingCheck(
  organization: string,
  org: OrganizationRow,
  helpUrl: string,
): CheckDraft {
  const label = environmentLabel(organization, org.name);
  const blocked = org.blockaccesstosessiontranscriptsforcopilotstudio;

  if (blocked === undefined) {
    return {
      id: 'transcript-viewing',
      title: CHECK_TITLES['transcript-viewing'],
      status: 'unknown',
      detail: `This environment did not report the setting for ${label}.`,
      helpUrl,
      helpLabel: 'Check in the admin center',
    };
  }

  return {
    id: 'transcript-viewing',
    title: CHECK_TITLES['transcript-viewing'],
    // A warning, not a failure: this governs who can read transcripts in Copilot
    // Studio, so it shapes what a reviewer sees rather than whether analysis runs.
    status: blocked ? 'warning' : 'pass',
    detail: blocked
      ? `Environment setting: agent owners and editors cannot see session transcripts in ${label}.`
      : `Environment setting: agent owners and editors can see session transcripts in ${label}.`,
    blocks: blocked ? 'Reviewers may not be able to open the transcripts behind a score' : undefined,
    helpUrl,
    helpLabel: 'Manage in the admin center',
  };
}

/**
 * The connection references the installed flow actually binds.
 *
 * Which Dataverse reference that is depends on which package installed the
 * flow: this app's solution ships `new_sharedcommondataserviceforapps_99a44867`,
 * while the Copilot Studio Kit's copy of the same flow binds
 * `cat_CopilotStudioAcceleratorDataverse`. The app is supported with and
 * without the Kit, so hardcoding either name is wrong in one of them — it
 * reports a reference that was never installed as "Missing" while never
 * checking the one the flow depends on.
 *
 * `clientdata` carries the whole flow definition as JSON, and every connection
 * it uses appears there as a `connectionReferenceLogicalName`. Scanned as text
 * rather than parsed because the surrounding shape differs between the trigger
 * and each action, and only the names are wanted. Returns nothing when the flow
 * is absent or unreadable, so the caller can fall back rather than report an
 * environment with no connection references at all.
 */
async function flowConnectionReferences(): Promise<string[]> {
  try {
    const rows = await list<WorkflowRow>(
      CURRENT_ORGANIZATION,
      'workflows',
      'workflowid,name,clientdata',
      `${FLOW_BASE_FILTER} and (${anyOf('name', REQUIRED_FLOWS)})`,
      REQUIRED_FLOWS.length + 5,
    );

    const names = new Set<string>();
    for (const row of rows) {
      for (const [, name] of (row.clientdata ?? '').matchAll(
        /"connectionReferenceLogicalName"\s*:\s*"([^"]+)"/g,
      )) {
        names.add(name);
      }
    }

    return [...names];
  } catch {
    return [];
  }
}

async function connectionsCheck(homeLabel: string, isHome: boolean): Promise<CheckDraft> {
  const title = CHECK_TITLES.connections;
  try {
    const discovered = await flowConnectionReferences();
    const required = discovered.length > 0 ? discovered : FALLBACK_CONNECTION_REFERENCES;

    const rows = await list<ConnectionReferenceRow>(
      CURRENT_ORGANIZATION,
      'connectionreferences',
      'connectionreferenceid,connectionreferencedisplayname,connectionreferencelogicalname,connectionid,connectorid',
      anyOf('connectionreferencelogicalname', required),
    );

    const byLogicalName = new Map(
      rows.map((row) => [row.connectionreferencelogicalname ?? '', row] as const),
    );

    const items: CheckItem[] = required.map((logicalName) => {
      const row = byLogicalName.get(logicalName);
      const rawId = row?.connectionid ?? '';
      const normalized = normalizeConnectionId(rawId);
      // A bound id we cannot parse is worth saying out loud: the badge used to
      // read "Mapped" from the raw column while the picker read `normalized`
      // and showed nothing selected, so the two silently disagreed.
      const unrecognised = Boolean(rawId) && normalized === null;

      return {
        id: logicalName,
        label: row?.connectionreferencedisplayname ?? logicalName,
        caption: unrecognised
          ? `${connectorLabel(row?.connectorid) ?? logicalName} · stored id "${rawId}"`
          : (connectorLabel(row?.connectorid) ?? logicalName),
        status: !row || !rawId ? 'fail' : unrecognised ? 'warning' : 'pass',
        stateLabel: !row
          ? 'Missing'
          : !rawId
            ? 'Not mapped'
            : unrecognised
              ? 'Unrecognised id'
              : 'Mapped',
        // The Agents connection is created by the Power Apps host when the user
        // consents to this app, so there is rarely an existing one to pick from
        // a list. It is configured by the guided action instead.
        guidedSetup: logicalName === AGENT_CONNECTION_REFERENCE ? 'agent-review' : undefined,
        // Everything the picker needs to offer alternatives and write the choice.
        connection: row
          ? {
              referenceId: row.connectionreferenceid ?? '',
              connectorId: row.connectorid ?? '',
              connectionId: normalized,
            }
          : undefined,
      };
    });

    // Only a missing binding blocks activation. An unparseable id is reported
    // but must not block: we cannot prove it is wrong. `RetrievePowerAppsConnections`
    // returns only the caller's own connections, and a solution-installed
    // reference normally points at one owned by whoever installed it, so an
    // id being unresolvable here is not evidence that it is broken.
    const unmapped = items.filter((item) => item.status === 'fail');
    const unrecognised = items.filter((item) => item.status === 'warning');

    const detail =
      unmapped.length > 0
        ? `${unmapped.length} of ${items.length} connection references still need a connection.`
        : unrecognised.length > 0
          ? `${unrecognised.length} of ${items.length} connection references hold an id this app cannot interpret. Verify them in Power Automate.`
          : `All ${items.length} connection references are mapped to a connection.`;

    return {
      id: 'connections',
      title,
      status: unmapped.length > 0 ? 'fail' : unrecognised.length > 0 ? 'warning' : 'pass',
      detail: scopeNote(detail, homeLabel, isHome),
      blocks: unmapped.length === 0 ? undefined : 'Blocks flow activation and analysis',
      items,
      helpUrl: 'https://make.powerapps.com/connections',
      helpLabel: 'Manage connections',
    };
  } catch (error) {
    return {
      id: 'connections',
      title,
      status: 'unknown',
      detail: error instanceof Error ? error.message : 'Could not read connection references.',
    };
  }
}

/** `/providers/Microsoft.PowerApps/apis/shared_x` → `shared_x`. */
function connectorLabel(connectorId?: string): string | undefined {
  if (!connectorId) return undefined;
  return connectorId.split('/').pop() ?? connectorId;
}

/**
 * Normalises any connection identifier to the 32-char compact hex form that
 * Dataverse persists in `connectionreferences.connectionid`.
 *
 * The platform hands out the same underlying GUID in several shapes. Observed
 * in a single environment: bare compact hex (`b0e9dee3…2458`), a hyphenated
 * GUID (`ee4e134d-31e8-…`), a connector-prefixed name
 * (`shared-teams-c3ecf2d9-6735-…`), and a full ARM path. Taking the last 32 hex
 * characters recovers the GUID from all of them, because the prefix contributes
 * only stray letters and the GUID always sits at the end.
 *
 * Deliberately returns `null` rather than falling back to the raw value: a
 * shorter string could collide by accident and show a false "Mapped". Callers
 * must treat `null` as "bound to something I cannot interpret" — *not* as
 * "unmapped", and not as proof the connection is broken.
 */
export function normalizeConnectionId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const hex = raw.toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.length >= 32 ? hex.slice(-32) : null;
}

function connectorApiName(connectorId: string): string {
  const tail = connectorId.includes('/') ? connectorId.split('/').pop()! : connectorId;
  return tail.toLowerCase();
}

export interface AvailableConnection {
  /** Raw API Hub name — pass this straight back to `mapConnection`. */
  name: string;
  /** 32-char compact hex, for comparing against what the reference holds. */
  normalizedId: string | null;
  displayName: string;
  status: string;
  /**
   * The caller's permission on the connection — "Owner", "CanEdit", "CanView".
   * `RetrievePowerAppsConnections` returns this but not a created date, so it
   * is the only per-connection detail available beyond the id.
   */
  role: string;
  /** Human-readable connector name, e.g. "Microsoft Dataverse". */
  connectorTypeDisplayName: string;
}

/**
 * Shape returned by the `RetrievePowerAppsConnections` unbound action. Note the
 * fields are flat here, unlike the API Hub `properties`-nested shape.
 */
interface PowerAppsConnection {
  name?: string;
  id?: string;
  apiId?: string;
  displayName?: string;
  status?: string;
  connectorTypeDisplayName?: string;
  maxAssignedRoleName?: string;
}

async function currentEnvironmentId(): Promise<string | undefined> {
  try {
    return (await getHostContext()).app.environmentId;
  } catch {
    return undefined;
  }
}

async function flowsCheck(
  connectionsReady: boolean,
  homeLabel: string,
  isHome: boolean,
): Promise<CheckDraft> {
  const title = CHECK_TITLES.flows;
  try {
    const rows = await list<WorkflowRow>(
      CURRENT_ORGANIZATION,
      'workflows',
      'workflowid,name,statecode',
      `${FLOW_BASE_FILTER} and (${anyOf('name', REQUIRED_FLOWS)})`,
      REQUIRED_FLOWS.length + 5,
    );

    const byName = new Map(rows.map((row) => [row.name ?? '', row] as const));

    const items: CheckItem[] = REQUIRED_FLOWS.map((name) => {
      const row = byName.get(name);
      const on = row?.statecode === 1;
      // A disabled switch with no explanation reads as "this environment is not
      // supported", so say which prerequisite is actually holding it back.
      const blockedByConnections = Boolean(row) && !on && !connectionsReady;
      return {
        id: row?.workflowid ?? name,
        label: name,
        caption: !row
          ? 'Not found. Install or import the solution'
          : blockedByConnections
            ? 'Map every connection reference above before this can be turned on'
            : undefined,
        status: !row ? 'fail' : on ? 'pass' : 'fail',
        stateLabel: !row ? 'Missing' : on ? 'On' : 'Off',
        // Turning a flow ON while a connection reference is unmapped would start
        // a flow that fails on its first run. Turning one OFF is always allowed.
        canEnable: Boolean(row) && !on && connectionsReady,
        canDisable: Boolean(row) && on,
        flowOn: on,
      };
    });

    const off = items.filter((item) => item.status !== 'pass');

    return {
      id: 'flows',
      title,
      status: off.length === 0 ? 'pass' : 'fail',
      detail: scopeNote(
        off.length === 0
          ? `All ${items.length} required flow${items.length === 1 ? ' is' : 's are'} on.`
          : connectionsReady
            ? `${off.length} of ${items.length} required flow${items.length === 1 ? ' still needs' : 's still need'} turning on.`
            : `${off.length} of ${items.length} required flow${items.length === 1 ? ' is' : 's are'} off. Map every connection first.`,
        homeLabel,
        isHome,
      ),
      blocks: off.length === 0 ? undefined : 'Blocks analysis runs',
      items,
    };
  } catch (error) {
    return {
      id: 'flows',
      title,
      status: 'unknown',
      detail: error instanceof Error ? error.message : 'Could not read cloud flows.',
    };
  }
}

// ─── guided agent-review setup ───────────────────────────────────────────────

/**
 * Ported from the Copilot Agent Kit Installer's "Set up agent review" button
 * (`agentReviewInstallerService.configureAgentReview`).
 *
 * The Agents connector is the one prerequisite a connection picker cannot
 * usefully solve. Its connection is created by the Power Apps host when the
 * user consents to this app — so at the moment the picker is rendered there is
 * typically nothing in the list, and the connections page offers no better
 * outcome than the consent the user has already given. The guided action closes
 * that loop instead: prove the connection works, find it, bind it, start the
 * flow.
 *
 * Two deliberate differences from the installer:
 *   - connections are found through `RetrievePowerAppsConnections` rather than
 *     the Power Apps for Makers connector, so no second connector is needed;
 *   - the retry lives in `setFlowState`, so the manual flow toggle benefits
 *     from it too.
 */

/** Backoff for activation after binding. See `activateWithRetry`. */
const ACTIVATION_RETRY_DELAYS_MS = [5_000, 10_000, 20_000] as const;

/** Connector behind the Agents connection reference. */
const AGENTS_CONNECTOR_ID = '/providers/Microsoft.PowerApps/apis/shared_agentnode';

export interface AgentReviewSetupState {
  /** The Agents connection reference points at a connection. */
  connectionMapped: boolean;
  /** `Review Agent Components` is on. */
  flowOn: boolean;
  /** Both of the above — nothing left to do. */
  isReady: boolean;
}

/**
 * True when a failure is the connection binding still propagating rather than a
 * real refusal.
 *
 * Dataverse accepts the `connectionid` write immediately but the flow service
 * learns about it seconds later, so an activation fired straight afterwards is
 * rejected with `ConnectionAuthorizationFailed`. Retrying is the documented
 * remedy; treating it as a hard failure makes setup look broken when it is
 * merely early.
 *
 * The message is buried at varying depths depending on which layer produced the
 * error, so the whole payload is searched rather than one expected field.
 */
function isConnectionPropagationFailure(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (typeof value === 'string') {
    return /ConnectionAuthorizationFailed|cannot be used to activate this flow/i.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => isConnectionPropagationFailure(entry, depth + 1));
  }
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).some((entry) =>
    isConnectionPropagationFailure(entry, depth + 1),
  );
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

interface WriteResult {
  success: boolean;
  error?: unknown;
  data?: unknown;
}

function writeFlowState(workflowId: string, on: boolean): Promise<WriteResult> {
  return MicrosoftDataverseService.UpdateRecordWithOrganization(
    'return=minimal',
    'application/json',
    CURRENT_ORGANIZATION,
    'workflows',
    workflowId,
    on ? { statecode: 1, statuscode: 2 } : { statecode: 0, statuscode: 1 },
  );
}

/**
 * Re-attempts activation while the failure still looks like the connection
 * binding propagating. Gives up the moment the error changes shape, so a
 * genuine permission failure is reported in seconds rather than after 35.
 */
async function activateWithRetry(workflowId: string, first: WriteResult): Promise<void> {
  let result = first;

  for (const delayMs of ACTIVATION_RETRY_DELAYS_MS) {
    if (!isConnectionPropagationFailure(result.error ?? result.data)) break;
    await wait(delayMs);
    result = await writeFlowState(workflowId, true);
    if (result.success) return;
  }

  if (result.success) return;

  throw new Error(
    isConnectionPropagationFailure(result.error ?? result.data)
      ? `${describeError(result)} The Agents connection is still being authorized for this flow. Wait a moment and press "Set up agent review" again.`
      : describeError(result),
  );
}

async function readAgentReviewRecords(): Promise<{
  reference: ConnectionReferenceRow | undefined;
  workflow: WorkflowRow | undefined;
}> {
  const [references, workflows] = await Promise.all([
    list<ConnectionReferenceRow>(
      CURRENT_ORGANIZATION,
      'connectionreferences',
      'connectionreferenceid,connectionid',
      `connectionreferencelogicalname eq '${odataLiteral(AGENT_CONNECTION_REFERENCE)}'`,
      1,
    ),
    list<WorkflowRow>(
      CURRENT_ORGANIZATION,
      'workflows',
      'workflowid,name,statecode,statuscode',
      `${FLOW_BASE_FILTER} and name eq '${odataLiteral(AGENT_REVIEW_FLOW)}'`,
      1,
    ),
  ]);

  return { reference: references[0], workflow: workflows[0] };
}

function toSetupState(
  reference: ConnectionReferenceRow | undefined,
  workflow: WorkflowRow | undefined,
): AgentReviewSetupState {
  const connectionMapped = Boolean(normalizeConnectionId(reference?.connectionid));
  const flowOn = workflow?.statecode === 1 && workflow?.statuscode === 2;
  return { connectionMapped, flowOn, isReady: connectionMapped && flowOn };
}

// ─── public surface ──────────────────────────────────────────────────────────

export const setupService = {
  /**
   * Runs every prerequisite check.
   *
   * The organization row is read once and shared: three checks need it, and it
   * also decides whether the environment is reachable at all — when it fails
   * there is nothing meaningful to say about the rest.
   *
   * `organization` selects the environment for environment-scoped checks only.
   * Connections and flows describe this app's own installation and always read
   * the environment the app runs in, whatever is selected.
   */
  async runChecks(organization: string = CURRENT_ORGANIZATION): Promise<SetupSummary> {
    const helpUrl = await adminSettingsUrl(organization);

    let org: OrganizationRow | undefined;
    let unreachable: string | undefined;
    try {
      org = await readOrganization(organization);
    } catch (error) {
      unreachable = error instanceof Error ? error.message : 'The environment did not answer.';
    }

    const home = await resolveHomeEnvironment(organization, org);

    if (!org) {
      return summarise(
        [
          {
            id: 'environment',
            title: CHECK_TITLES.environment,
            status: 'fail',
            detail: unreachable ?? 'The environment did not answer.',
            blocks: 'Blocks every check below',
          },
        ],
        helpUrl,
        home,
      );
    }

    const [copilotStudio, securityRole, connections] = await Promise.all([
      copilotStudioCheck(organization, org),
      securityRoleCheck(organization, org),
      connectionsCheck(home.name, home.isHome),
    ]);

    // A warning counts as ready: it means a connection *is* bound, just with an
    // id this app cannot parse. Only a hard failure (nothing bound) or 'unknown'
    // (we could not read the references at all) should hold activation back.
    const connectionsReady =
      connections.status === 'pass' || connections.status === 'warning';
    const flows = await flowsCheck(connectionsReady, home.name, home.isHome);

    return summarise(
      [
        environmentCheck(organization, org),
        copilotStudio,
        securityRole,
        transcriptRecordingCheck(organization, org, helpUrl),
        transcriptViewingCheck(organization, org, helpUrl),
        connections,
        flows,
      ],
      helpUrl,
      home,
    );
  },

  /**
   * Turns a cloud flow on or off. Mirrors PowerShield: `statecode 1 / statuscode 2`.
   *
   * Flows are part of this app's installation, so this always writes to the
   * environment the app runs in regardless of what the environment picker shows.
   */
  async setFlowState(workflowId: string, on: boolean): Promise<void> {
    const result = await writeFlowState(workflowId, on);
    if (result.success) return;

    // Only activation can hit the propagation race, and only right after a
    // connection was bound. Deactivation has no such window.
    if (on && isConnectionPropagationFailure(result.error ?? result.data)) {
      await activateWithRetry(workflowId, result);
      return;
    }

    const message = describeError(result);
    const verb = on ? 'turn this flow on' : 'turn this flow off';
    if (/privilege|permission/i.test(message)) {
      throw new Error(
        `You need owner or co-owner rights on this flow to ${verb}. Open it in Power Automate, or ask its owner.`,
      );
    }
    if (/managed/i.test(message)) {
      throw new Error(
        `This managed flow cannot be changed from here. Use Power Automate, or contact the solution owner.`,
      );
    }
    throw new Error(message);
  },

  /** Back-compat alias — `setFlowState(id, true)`. */
  async activateFlow(workflowId: string): Promise<void> {
    return setupService.setFlowState(workflowId, true);
  },

  /** Current state of the guided Agents setup, without changing anything. */
  async getAgentReviewSetupState(): Promise<AgentReviewSetupState> {
    const { reference, workflow } = await readAgentReviewRecords();
    return toSetupState(reference, workflow);
  },

  /**
   * One-click Agents setup: validate, bind, activate, verify.
   *
   * Each step is skipped when already satisfied, so pressing the button on a
   * healthy installation is a no-op that simply re-confirms the state.
   */
  async setupAgentReview(): Promise<AgentReviewSetupState> {
    const { reference, workflow } = await readAgentReviewRecords();

    if (!reference) {
      throw new Error(
        `The ${AGENT_CONNECTION_REFERENCE} connection reference is not in this environment. Install or import the Copilot Studio Kit solution first.`,
      );
    }
    if (!workflow?.workflowid) {
      throw new Error(
        `The "${AGENT_REVIEW_FLOW}" flow is not in this environment. Install or import the Copilot Studio Kit solution first.`,
      );
    }

    const before = toSetupState(reference, workflow);
    if (before.isReady) return before;

    if (!before.connectionMapped) {
      const connections = await setupService.listAvailableConnections(AGENTS_CONNECTOR_ID);
      const connection = connections[0];
      if (!connection) {
        throw new Error(
          'No connected Agents (Microsoft Copilot Studio) connection was found in this environment. Create one in Power Automate under Connections, then try again.',
        );
      }
      await setupService.mapConnection(reference.connectionreferenceid ?? '', connection.name);
    }

    if (!before.flowOn) {
      await setupService.setFlowState(workflow.workflowid, true);
    }

    const after = await readAgentReviewRecords();
    const verified = toSetupState(after.reference, after.workflow);
    if (!verified.isReady) {
      throw new Error(
        'Setup did not finish. The connection was saved but the flow is still off. Re-check in a moment, or turn it on from Power Automate.',
      );
    }
    return verified;
  },

  /**
   * Connections for a given connector, so a user can pick a different one.
   *
   * Uses the `RetrievePowerAppsConnections` unbound Dataverse action rather
   * than the Power Apps for Makers connector, matching `Agent-Library`'s
   * ConnectionService. Two reasons this is the better route:
   *   - no extra connector data source, so no extra consent prompt or DLP surface;
   *   - the API Hub route silently ignored its `apiId` filter and returned every
   *     connector in the environment anyway.
   *
   * Always reads the home environment: connection references are global
   * configuration, so the environment picker must not steer this.
   *
   * Note this returns only connections the *caller* can see. A reference
   * installed with a solution normally points at one owned by whoever installed
   * it, so an absent id here is not evidence of a broken reference — do not use
   * this list to validate existing bindings.
   *
   * Only `Connected` connections are offered — mapping a reference to a broken
   * connection produces a flow that fails on its first run.
   */
  async listAvailableConnections(connectorId: string): Promise<AvailableConnection[]> {
    const apiName = connectorApiName(connectorId);
    const result = await MicrosoftDataverseService.PerformUnboundActionWithOrganization(
      CURRENT_ORGANIZATION,
      'RetrievePowerAppsConnections',
    );

    if (!result.success) throw new Error(describeError(result));

    const data = result.data as
      | { Connections?: PowerAppsConnection[]; connections?: PowerAppsConnection[]; value?: PowerAppsConnection[] }
      | undefined;
    const rows = data?.Connections ?? data?.connections ?? data?.value ?? [];

    return rows
      // `endsWith` rather than `includes`: shared_commondataservice is a
      // genuine prefix of shared_commondataserviceforapps.
      .filter((row) => (row.apiId ?? '').toLowerCase().endsWith(`/apis/${apiName}`))
      .filter((row) => !row.status || row.status.toLowerCase() === 'connected')
      .map((row) => ({
        name: row.name ?? '',
        normalizedId: normalizeConnectionId(row.name),
        displayName: row.displayName ?? row.name ?? '',
        status: row.status ?? 'Connected',
        role: row.maxAssignedRoleName ?? '',
        connectorTypeDisplayName: row.connectorTypeDisplayName ?? '',
      }))
      // The action returns no created date, so there is nothing meaningful to
      // rank by. Sort by id purely so the order is stable between loads — a
      // list of 15 identically-named connections that reshuffles is worse than
      // one in an arbitrary but fixed order.
      .sort((a, b) => a.name.localeCompare(b.name));
  },

  /**
   * Deep link to create a connection for a connector, for when none of the
   * existing ones are right.
   */
  async createConnectionUrl(connectorId: string): Promise<string | undefined> {
    const environmentId = await currentEnvironmentId();
    if (!environmentId) return undefined;
    return `https://make.powerapps.com/environments/${environmentId}/connections/available/${connectorApiName(connectorId)}`;
  },

  /** Points a connection reference at a connection. */
  async mapConnection(connectionReferenceId: string, connectionName: string): Promise<void> {
    const normalized = normalizeConnectionId(connectionName);
    if (!normalized) {
      throw new Error(
        `"${connectionName}" does not contain a valid 32-character connection id.`,
      );
    }

    const result = await MicrosoftDataverseService.UpdateRecordWithOrganization(
      'return=minimal',
      'application/json',
      CURRENT_ORGANIZATION,
      'connectionreferences',
      connectionReferenceId,
      { connectionid: normalized },
    );

    if (!result.success) {
      const message = describeError(result);
      if (/privilege|permission/i.test(message)) {
        throw new Error(
          'You need permission to edit this connection reference. It is usually owned by the solution installer.',
        );
      }
      throw new Error(message);
    }
  },
};
