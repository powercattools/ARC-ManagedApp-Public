/**
 * Which harness reviewed a snapshot, read from the snapshot's own agent rows.
 *
 * The grid's Harness column cannot be answered from the project row. The same asset type covers both
 * the Copilot and the Standard harness, and which one applies is decided by the reviewed agent's own
 * configuration at capture time — so the project row, written before any agent was captured, cannot
 * know it. The engine records it per agent, which makes the snapshot's parent agent row the only
 * authority for it.
 *
 * Read through the connector rather than a generated service, for the reason `snapshot-progress`
 * gives: `cat_architecturereviewagent` is written by the engine over that same transport, and a
 * second client for one table is two things that can drift apart.
 */

import { artService } from './art-service';
import { createConnectorTransport } from './connector-transport';
import { AGENT_SET } from '../engine/persistence/schema/architecture-review-agent.ts';
import type { HarnessName } from '../models/review';

/** Mirrors `HARNESS_OPTIONS` in `engine/persistence/schema/metadata.ts`. */
const HARNESS_BY_CHOICE: Record<number, HarnessName> = {
  1: 'standard',
  2: 'copilot',
  3: 'declarative-agent',
  4: 'skill',
};

const SELECT = '_cat_resultid_value,cat_harness,cat_depth,cat_agentid';

interface AgentHarnessRow {
  _cat_resultid_value?: string;
  cat_harness?: number | string;
  cat_depth?: number | string;
  cat_agentid?: string;
}

/**
 * What the parent agent row says about a snapshot.
 *
 * The harness answers the grid's column. The subject id answers a different question that only the
 * detail page asks: whether two snapshots reviewed the same thing. For a bot-backed harness it is
 * the bot id and never changes; for an uploaded skill it is the fabricated subject id, which changes
 * when the author uploads an artifact naming a different skill (`harness-skill.md` §6.2).
 */
export interface SnapshotSubject {
  harness: HarnessName;
  agentId?: string;
}

/**
 * The parent agent row of each given snapshot, keyed by snapshot id.
 *
 * One call for the whole page rather than one per snapshot, so the cost does not grow with the
 * number of snapshots on it.
 */
export async function subjectBySnapshot(
  snapshotIds: readonly string[],
): Promise<Map<string, SnapshotSubject>> {
  const found = new Map<string, SnapshotSubject>();
  if (snapshotIds.length === 0) return found;

  const context = await artService.linkContext();
  if (!context.organizationUrl) return found;

  const transport = createConnectorTransport(context.organizationUrl);
  const filter = snapshotIds.map((id) => `_cat_resultid_value eq ${id}`).join(' or ');
  const rows = (await transport.rows(
    `${AGENT_SET}?$select=${SELECT}&$filter=${filter}`,
    500,
  )) as AgentHarnessRow[];

  for (const row of rows) {
    const snapshot = row._cat_resultid_value;
    const harness = HARNESS_BY_CHOICE[Number(row.cat_harness)];
    // Only the parent agent speaks for the run. A copilot parent can fan out to a classic connected
    // agent, so labelling the snapshot from whichever row came back first would be a coin toss.
    if (!snapshot || !harness || Number(row.cat_depth) !== 0) continue;
    found.set(snapshot, { harness, agentId: row.cat_agentid });
  }
  return found;
}

/**
 * The harness of each given snapshot, keyed by snapshot id, for the snapshots that have agent rows.
 */
export async function harnessBySnapshot(
  snapshotIds: readonly string[],
): Promise<Map<string, HarnessName>> {
  const subjects = await subjectBySnapshot(snapshotIds);
  return new Map([...subjects].map(([snapshot, subject]) => [snapshot, subject.harness]));
}
