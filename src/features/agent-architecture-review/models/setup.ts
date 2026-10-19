/**
 * Domain types for the Setup surface (spec 015, Phase 2 — FR-029 to FR-037).
 *
 * A prerequisite check carries everything its card needs to render: a status, a
 * one-line detail, an optional blocking consequence, and optional rows revealed
 * when the card expands.
 *
 * Checks are of two kinds. Most answer a question about the environment
 * currently selected in the picker. A few — connections and flows — describe
 * the app's own installation and are the same whichever environment is
 * selected; see `CheckScope`.
 */

/**
 * `unknown` is a first-class outcome, not an error. Some readiness signals are
 * genuinely not knowable from the app (an environment-group rule can override
 * an environment setting without changing it), and reporting a confident
 * pass/fail there would be worse than admitting the gap.
 */
export type CheckStatus = 'pass' | 'fail' | 'warning' | 'unknown';

/**
 * Whether a check answers for the environment being inspected, or for the one
 * the app itself is installed in.
 *
 * Connections and flows belong to the installation, not to the environment
 * under review: there is a single `Review Agent Components` flow and a single
 * set of connection references, and they serve every environment the app looks
 * at. Rendering them under the environment picker implied each environment had
 * its own copy, and invited edits that would silently retarget the shared
 * installation for everyone.
 */
export type CheckScope = 'global' | 'environment';

export type CheckId =
  | 'environment'
  | 'copilot-studio'
  | 'security-role'
  | 'transcript-recording'
  | 'transcript-viewing'
  | 'connections'
  | 'flows';

/** A row inside an expanded card. `action` is rendered by the card, not here. */
export interface CheckItem {
  id: string;
  label: string;
  /** Secondary line, e.g. the connector a connection reference binds to. */
  caption?: string;
  status: CheckStatus;
  /** Short state word shown as a badge, e.g. "Mapped", "Off". */
  stateLabel?: string;
  /** Cloud flows: whether the app may turn this flow on / off right now. */
  canEnable?: boolean;
  canDisable?: boolean;
  flowOn?: boolean;
  /**
   * This row is configured by a single guided action rather than by picking a
   * connection by hand. Set for the Agents reference, whose connection the
   * Power Apps host creates on consent — so there is nothing useful to pick
   * from a list, and sending the user to the connections page would strand them
   * on a connector they cannot usefully create in isolation.
   */
  guidedSetup?: 'agent-review';
  /** Connection references: everything the picker needs to offer and save a choice. */
  connection?: {
    referenceId: string;
    connectorId: string;
    /** Currently mapped connection, normalised to 32-char compact hex. */
    connectionId: string | null;
  };
}

export interface PrerequisiteCheck {
  id: CheckId;
  title: string;
  status: CheckStatus;
  /** One line under the title — the environment and what was found. */
  detail: string;
  /**
   * What a failure costs, shown as a red chip. Present only when the check is
   * not passing, so a healthy card stays quiet.
   */
  blocks?: string;
  items?: CheckItem[];
  /** Deep link for a fix the app cannot perform itself. */
  helpUrl?: string;
  helpLabel?: string;
  /** Stamped by `summarise` from `CHECK_SCOPES`, so no check can omit it. */
  scope: CheckScope;
}

export interface SetupSummary {
  checks: PrerequisiteCheck[];
  readyCount: number;
  totalCount: number;
  blockingCount: number;
  /** Admin-center link for the checked environment, for "Copy admin link". */
  adminUrl: string;
  /**
   * Whether the environment being inspected is the one the app runs in. Global
   * checks are only editable when it is — elsewhere they are shown read-only so
   * the reader can see the shared configuration without being able to change it
   * from a context that does not own it.
   */
  isHomeEnvironment: boolean;
  /** Name of the environment the app runs in, so the UI can say where globals live. */
  homeEnvironmentName: string;
}

/** Ordering and display names for the checklist. */
export const CHECK_TITLES: Record<CheckId, string> = {
  environment: 'Environment reachable',
  'copilot-studio': 'Copilot Studio provisioned',
  'security-role': 'You have the access this environment needs',
  'transcript-recording': 'Transcript recording enabled at environment level',
  'transcript-viewing': 'Transcript viewing enabled for agent owners',
  connections: 'Connections enabled',
  flows: 'Flows enabled',
};

export const CHECK_SCOPES: Record<CheckId, CheckScope> = {
  environment: 'environment',
  'copilot-studio': 'environment',
  'security-role': 'environment',
  'transcript-recording': 'environment',
  'transcript-viewing': 'environment',
  connections: 'global',
  flows: 'global',
};

export const CHECK_ORDER: CheckId[] = [
  'environment',
  'copilot-studio',
  'security-role',
  'transcript-recording',
  'transcript-viewing',
  'connections',
  'flows',
];

export interface HomeEnvironment {
  isHome: boolean;
  name: string;
}

/** A check as authored. `summarise` stamps the scope, so builders cannot omit it. */
export type CheckDraft = Omit<PrerequisiteCheck, 'scope'>;

export function summarise(
  checks: CheckDraft[],
  adminUrl: string,
  home: HomeEnvironment,
): SetupSummary {
  const scoped: PrerequisiteCheck[] = checks.map((check) => ({
    ...check,
    scope: CHECK_SCOPES[check.id],
  }));

  return {
    checks: scoped,
    readyCount: scoped.filter((check) => check.status === 'pass').length,
    totalCount: scoped.length,
    blockingCount: scoped.filter((check) => check.status === 'fail').length,
    adminUrl,
    isHomeEnvironment: home.isHome,
    homeEnvironmentName: home.name,
  };
}
