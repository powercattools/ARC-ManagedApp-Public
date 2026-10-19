/**
 * Per-agent scores across the snapshots of one review.
 *
 * `cat_architecturereviewagent` already holds one row per agent per snapshot, carrying the score the
 * review settled on and the agent's place in the graph. That makes the score history the progress
 * tracker charts a read, not a new thing to store: nothing here is derived that the engine has not
 * already written, so a chart can never disagree with the snapshot it came from.
 *
 * Read through the connector rather than a generated service, for the reason `snapshot-harness`
 * gives: this table is written by the engine over that same transport, and a second client for one
 * table is two things that can drift apart.
 */

import { artService } from './art-service';
import { createConnectorTransport } from './connector-transport';
import { AGENT_SET } from '../engine/persistence/schema/architecture-review-agent.ts';

const SELECT = [
  '_cat_resultid_value',
  'cat_agentid',
  'cat_agentname',
  'cat_score',
  'cat_role',
  'cat_depth',
].join(',');

/** Mirrors the `cat_role` option set: 1 Parent, 2 Connected. */
const PARENT_ROLE = 1;

interface AgentScoreRow {
  _cat_resultid_value?: string;
  cat_agentid?: string;
  cat_agentname?: string;
  cat_score?: number | string | null;
  cat_role?: number | string;
  cat_depth?: number | string;
}

/** One agent as it was reviewed inside one snapshot. */
export interface SnapshotAgentScore {
  agentId: string;
  agentName: string;
  /** The parent of the reviewed graph — the agent the review is *about*. */
  isParent: boolean;
  depth: number;
  /** Null when the agent's review produced no score, which is not the same as a score of zero. */
  score: number | null;
}

function numberOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The agent rows of each given snapshot, keyed by snapshot id.
 *
 * One call for the whole review rather than one per snapshot, so the cost of the page does not grow
 * with the length of the history it is drawing.
 *
 * An empty map is a legitimate answer, not a failure: snapshots recorded before the engine wrote
 * agent rows have none, and the caller charts those from the snapshot's own score instead.
 */
export async function agentScoresBySnapshot(
  snapshotIds: readonly string[],
): Promise<Map<string, SnapshotAgentScore[]>> {
  const found = new Map<string, SnapshotAgentScore[]>();
  if (snapshotIds.length === 0) return found;

  const context = await artService.linkContext();
  if (!context.organizationUrl) return found;

  const transport = createConnectorTransport(context.organizationUrl);
  const filter = snapshotIds.map((id) => `_cat_resultid_value eq ${id}`).join(' or ');
  const rows = (await transport.rows(
    `${AGENT_SET}?$select=${SELECT}&$filter=${filter}`,
    500,
  )) as AgentScoreRow[];

  for (const row of rows) {
    const snapshot = row._cat_resultid_value;
    const agentId = row.cat_agentid;
    if (!snapshot || !agentId) continue;

    const depth = numberOrNull(row.cat_depth) ?? 0;
    const forSnapshot = found.get(snapshot) ?? [];
    forSnapshot.push({
      agentId: agentId.toLowerCase(),
      agentName: row.cat_agentname || 'Unnamed agent',
      // Depth is the reliable marker — an older row may carry no role at all, and depth zero is
      // what the engine writes for the agent the snapshot is about.
      isParent: Number(row.cat_role) === PARENT_ROLE || depth === 0,
      depth,
      score: numberOrNull(row.cat_score),
    });
    found.set(snapshot, forSnapshot);
  }

  return found;
}
