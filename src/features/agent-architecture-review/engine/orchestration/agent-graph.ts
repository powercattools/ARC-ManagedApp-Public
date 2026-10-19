/**
 * Expand one agent into the set of agents a snapshot has to review.
 *
 * A Copilot agent that delegates to connected agents is not fully described by its own
 * configuration: the work it does is spread across the agents it calls. Reviewing only the parent
 * would score the orchestration and none of the behaviour, so a snapshot covers the parent and
 * every agent it reaches.
 *
 * Discovery is a by-product of parsing rather than a separate crawl. `parseAgentsExperience`
 * already resolves the parent's connected-agent declarations, so each child is found by resolving a
 * schema name the parent named — which is exactly how ART's agent map does it, using the same
 * query.
 *
 * Browser-safe. No `Buffer`, no `process`, no generated Dataverse client.
 */

import { captureAgent, type AgentCapture } from '../capture/agent-capture';
import { createBotService } from '../capture/bot-service';
import type { EngineTransport } from '../contracts/transport';
import type { AgentRole } from '../contracts/review-progress';

/** One agent a snapshot will review. */
export interface AgentWorkItem {
  agentId: string;
  agentName: string;
  role: AgentRole;
  /** Depth from the parent: 0 for the parent, 1 for an agent it calls directly. */
  depth: number;
  capture: AgentCapture;
}

/** A connected agent the parent named but which could not be reviewed. */
export interface UnresolvedAgent {
  /** Schema name as declared on the parent. */
  schemaName: string;
  /** Display name from the parent's declaration, when it carried one. */
  declaredName?: string;
  reason: string;
}

export interface AgentGraph {
  items: AgentWorkItem[];
  unresolved: UnresolvedAgent[];
}

export interface ExpandOptions {
  /**
   * How far to follow connected agents. 1 covers the parent and the agents it calls directly,
   * which is what a snapshot reviews today.
   *
   * Deeper graphs are legal and the traversal is written for them, but each level multiplies both
   * capture time and workflow cost, so going deeper is a deliberate choice rather than a default.
   */
  maxDepth?: number;
  onDiscovered?: (item: AgentWorkItem) => void;
  signal?: AbortSignal;
}

/**
 * Capture the parent and every connected agent it reaches.
 *
 * A connected agent that cannot be resolved is recorded rather than thrown. Copilot Studio lets an
 * agent declare a connected agent that lives in another environment, or that has since been
 * unpublished; neither makes the parent unreviewable, and failing the whole snapshot for one
 * missing child would make the common case hostage to the rare one.
 *
 * Cycles are possible — two agents can name each other — so agents already captured are skipped.
 */
export async function expandAgentGraph(
  transport: EngineTransport,
  parentBotId: string,
  options: ExpandOptions = {},
): Promise<AgentGraph> {
  const { maxDepth = 1, onDiscovered, signal } = options;
  const bots = createBotService(transport);

  const items: AgentWorkItem[] = [];
  const unresolved: UnresolvedAgent[] = [];
  const seenAgents = new Set<string>();
  const seenSchemas = new Set<string>();

  const parent = await captureAgent(transport, parentBotId, signal);
  const parentItem: AgentWorkItem = {
    agentId: parent.botId,
    agentName: parent.botName,
    role: 'parent',
    depth: 0,
    capture: parent,
  };
  items.push(parentItem);
  seenAgents.add(parent.botId.toLowerCase());
  if (parent.schemaName) seenSchemas.add(parent.schemaName.toLowerCase());
  onDiscovered?.(parentItem);

  // Breadth-first, so every agent at one remove is discovered before anything deeper. The dialog
  // lists agents in discovery order, and a user reads that list as "the agent, then what it calls".
  let frontier: AgentWorkItem[] = [parentItem];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth += 1) {
    const next: AgentWorkItem[] = [];

    for (const current of frontier) {
      // A standard agent terminates the walk: its children are `AgentDialog` components inside it,
      // not separate agents, so there is nothing to follow and nothing unresolved to report.
      if (current.capture.harness !== 'copilot') continue;

      for (const connected of current.capture.model.connectedAgents) {
        if (signal?.aborted) throw new Error('Review cancelled');

        const schemaName = connected.botSchemaName?.trim();
        if (!schemaName) {
          unresolved.push({
            schemaName: connected.schemaname,
            declaredName: connected.displayName ?? connected.name,
            reason: 'The parent does not name a target agent for this connection.',
          });
          continue;
        }

        const key = schemaName.toLowerCase();
        if (seenSchemas.has(key)) continue;
        seenSchemas.add(key);

        try {
          const match = await bots.getBotBySchemaName(schemaName);
          if (!match) {
            unresolved.push({
              schemaName,
              declaredName: connected.displayName ?? connected.name,
              // The common cause by far, and the one a user can act on.
              reason:
                'No active published agent with this schema name exists in the reviewed environment. ' +
                'It may live in a different environment.',
            });
            continue;
          }

          if (seenAgents.has(match.botId.toLowerCase())) continue;
          seenAgents.add(match.botId.toLowerCase());

          // Captured rather than taken from `loadConnectedAgentMapSnapshotWith`, which returns a
          // parsed model but no assembled bundles. Reviewing needs the bundles, and capturing here
          // reads each component once instead of once for the map and again for the review.
          const capture = await captureAgent(transport, match.botId, signal);
          const item: AgentWorkItem = {
            agentId: capture.botId,
            agentName: capture.botName,
            role: 'connected',
            depth,
            capture,
          };
          items.push(item);
          next.push(item);
          onDiscovered?.(item);
        } catch (error) {
          unresolved.push({
            schemaName,
            declaredName: connected.displayName ?? connected.name,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    frontier = next;
  }

  return { items, unresolved };
}
