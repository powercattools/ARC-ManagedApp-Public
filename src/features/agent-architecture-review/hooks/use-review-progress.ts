/**
 * The progress page's data: a review's snapshots, and one score line per agent within them.
 *
 * Two queries rather than one, because the snapshots are already cached under `useReviewResults` for
 * the timeline and the snapshot switcher. Re-fetching them here to bundle the two into a single call
 * would buy nothing and cost a round trip the page has already paid for.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useReviewResults } from './use-reviews';
import { agentScoresBySnapshot, type SnapshotAgentScore } from '../services/snapshot-agent-scores';
import { buildReviewProgress, type ReviewProgress } from '../services/review-progress';
import type { ReviewResult } from '../models/review';

const EMPTY_SCORES: ReadonlyMap<string, SnapshotAgentScore[]> = new Map();

export interface UseReviewProgress {
  results: readonly ReviewResult[];
  progress: ReviewProgress;
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
}

export function useReviewProgress(reviewId: string, fallbackName: string): UseReviewProgress {
  const results = useReviewResults(reviewId);

  const snapshotIds = useMemo(
    () => (results.data ?? []).map((result) => result.id).sort(),
    [results.data],
  );

  const scores = useQuery({
    // Keyed on the snapshots themselves: a new snapshot is a new question, and keying only on the
    // review would serve the previous answer to it.
    queryKey: ['review-agent-scores', reviewId, snapshotIds.join(',')] as const,
    queryFn: () => agentScoresBySnapshot(snapshotIds),
    enabled: snapshotIds.length > 0,
  });

  const progress = useMemo(
    () => buildReviewProgress(results.data ?? [], scores.data ?? EMPTY_SCORES, fallbackName),
    [results.data, scores.data, fallbackName],
  );

  return {
    results: results.data ?? [],
    progress,
    isPending: results.isPending || (snapshotIds.length > 0 && scores.isPending),
    // A failed score read costs the chart, not the page: the timeline below it is still readable,
    // and the fallback line keeps the panel honest rather than empty.
    isError: results.isError,
    refetch: () => {
      void results.refetch();
      void scores.refetch();
    },
  };
}
