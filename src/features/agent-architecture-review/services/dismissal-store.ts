/**
 * Where a reviewer's "Ignore this rule" decisions live.
 *
 * On the agent row — `cat_architecturereviewagent.cat_dismissedrules` — rather than inside the
 * review payload, for two reasons. Toggling a rule becomes one small write instead of rewriting a
 * review document that can run to megabytes, and the judgement stays attached to the snapshot it
 * was made against, so reopening an older snapshot shows the score its reader actually saw.
 *
 * Carrying them forward is a separate act, done when the next snapshot is written. That is the
 * difference between "this snapshot was read with these rules set aside" and "this agent has these
 * rules set aside from now on", and only the first is a fact about a snapshot.
 *
 * The rubric owns everything about what a dismissal *means*; this module only moves the list — and,
 * in the same write, the score cache that list revises. `cat_score` on this row is a derived copy of
 * the review's number, so once a decision changes what that number is, leaving the copy behind is
 * what made the grid and the report disagree with the screen.
 */

import { MicrosoftDataverseService } from '../../../data';
import { CURRENT_ORGANIZATION } from './art-service';
import { parseDismissals, serializeDismissals, type RuleDismissal } from '../engine/scoring/art-ports';

const AGENT_SET = 'cat_architecturereviewagents';
const AGENT_ID = 'cat_architecturereviewagentid';
const COLUMN = 'cat_dismissedrules';
const SCORE = 'cat_score';

/** `snapshotId:agentId` — the same correlation the persistence layer stamps on every agent row. */
function correlation(snapshotId: string, agentId: string): string {
  return `${snapshotId}:${agentId}`;
}

interface AgentRow {
  [AGENT_ID]?: unknown;
  [COLUMN]?: unknown;
}

/**
 * The connector routes by an `organization` argument and resolves this app's own environment from
 * the literal `'current'`.
 *
 * That is why these calls do not go through `ConnectorTransport`: it takes a real environment URL
 * for the *reviewed* environment and parses it, so handing it the sentinel throws before a request
 * is ever made. The two operations below order their parameters differently — list takes the
 * organization first, update takes the headers first — so each is spelled out rather than shared.
 */
async function findRow(snapshotId: string, agentId: string): Promise<AgentRow | undefined> {
  const result = await MicrosoftDataverseService.ListRecordsWithOrganization(
    CURRENT_ORGANIZATION,
    AGENT_SET,
    '',
    'application/json',
    false,
    false,
    `${AGENT_ID},${COLUMN}`,
    `cat_correlationid eq '${correlation(snapshotId, agentId)}'`,
    // $orderby, $expand and fetchXml must be omitted entirely — an empty string is sent as an empty
    // query option and Dataverse rejects it.
    undefined,
    undefined,
    undefined,
    2,
  );

  if (!result.success) throw new Error('The environment did not answer.');
  const rows = (result.data as { value?: unknown })?.value;
  return Array.isArray(rows) ? (rows[0] as AgentRow | undefined) : undefined;
}

/**
 * The rules set aside for one agent in one snapshot.
 *
 * An unreadable or missing row reads as "none". A snapshot written before this column existed, or
 * one whose agent row could not be found, is not an error state — it simply has no dismissals, and
 * failing the whole results screen over that would be a poor trade.
 */
export async function readDismissals(
  snapshotId: string,
  agentId: string,
): Promise<RuleDismissal[]> {
  try {
    const row = await findRow(snapshotId, agentId);
    const raw = row?.[COLUMN];
    return parseDismissals(typeof raw === 'string' ? raw : null);
  } catch {
    return [];
  }
}

/**
 * Replace the stored list for one agent in one snapshot, and the score that list produces.
 *
 * Whole-list writes rather than add/remove deltas: the list is small, the caller already holds it
 * to render it, and a delta protocol would need conflict handling to buy nothing.
 *
 * Both columns go in one PATCH deliberately. The score is a cache of what the rubric makes of these
 * exact decisions, so writing them separately opens a window where the row says a rule was set aside
 * and still reports the score from before it was — which is the state the screen and the grid were
 * found in. `revisedScore` omitted leaves the cached score untouched, for callers that are moving a
 * list without having scored it.
 *
 * Throws when the write fails. Unlike reading, a silent failure here would show the reviewer a
 * score that will be gone when they come back.
 */
export async function writeDismissals(
  snapshotId: string,
  agentId: string,
  dismissals: readonly RuleDismissal[],
  revisedScore?: number | null,
): Promise<void> {
  const row = await findRow(snapshotId, agentId);
  const rowId = row?.[AGENT_ID];
  if (typeof rowId !== 'string' || !rowId) {
    throw new Error('This snapshot has no agent row to record the decision against.');
  }

  const result = await MicrosoftDataverseService.UpdateRecordWithOrganization(
    '',
    'application/json',
    CURRENT_ORGANIZATION,
    AGENT_SET,
    rowId,
    {
      [COLUMN]: serializeDismissals(dismissals),
      // A review that produced no score keeps an empty one: "not scored" and "scored zero" are
      // different findings, and this column is read for both.
      ...(typeof revisedScore === 'number' && Number.isFinite(revisedScore)
        ? { [SCORE]: Math.round(revisedScore) }
        : {}),
    },
    false,
  );
  if (!result.success) throw new Error('The environment rejected the change.');
}

/**
 * The dismissals recorded against an agent in a given snapshot.
 *
 * Kept for callers that already know which snapshot they mean. Carrying decisions into a *new*
 * snapshot is the persistence layer's job, and it finds the predecessor from the agent's own rows.
 */
export async function readPreviousDismissals(
  previousSnapshotId: string | undefined,
  agentId: string,
): Promise<RuleDismissal[]> {
  if (!previousSnapshotId) return [];
  return readDismissals(previousSnapshotId, agentId);
}
