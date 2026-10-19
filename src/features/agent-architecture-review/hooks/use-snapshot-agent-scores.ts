/**
 * The per-agent scores this app holds against one snapshot.
 *
 * A shared report prints a score for every agent it covers, and `cat_architecturereviewagent` is
 * where that number lives once a reviewer has set rules aside. The aggregated review cannot answer
 * it: that carries the rubric's original verdict, which is the right number for the Agent Review
 * Tool to keep showing and the wrong one for a report exported from a page that has already
 * credited the reviewer's judgement.
 */

import { useQuery } from '@tanstack/react-query';
import { agentScoresBySnapshot } from '../services/snapshot-agent-scores';

/** Stable identity, so a caller reading it straight into a memo does not rerun on every render. */
const EMPTY: ReadonlyMap<string, number | null> = new Map();

export interface UseSnapshotAgentScores {
  /** Keyed by agent id, lowercased — ids reach this page in both cases. */
  data: ReadonlyMap<string, number | null>;
  isPending: boolean;
  isError: boolean;
}

/**
 * An empty map is a legitimate answer, not a failure: a snapshot saved before this app wrote agent
 * rows has none, and the caller falls back to the review's own score rather than reporting an agent
 * as unscored. The same is true of a failed read, which is why the error is reported separately and
 * costs the caller nothing it cannot recover from.
 */
export function useSnapshotAgentScores(snapshotId?: string): UseSnapshotAgentScores {
  const query = useQuery({
    queryKey: ['snapshot-agent-scores', snapshotId] as const,
    queryFn: async () => {
      if (!snapshotId) return EMPTY;
      const bySnapshot = await agentScoresBySnapshot([snapshotId]);
      const scores = new Map<string, number | null>();
      for (const row of bySnapshot.get(snapshotId) ?? []) scores.set(row.agentId, row.score);
      return scores as ReadonlyMap<string, number | null>;
    },
    enabled: Boolean(snapshotId),
  });

  return {
    data: query.data ?? EMPTY,
    isPending: Boolean(snapshotId) && query.isPending,
    isError: query.isError,
  };
}
