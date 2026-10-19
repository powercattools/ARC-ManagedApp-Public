/**
 * React Query bindings for Agent Review Tool data.
 *
 * Kept separate from `use-reviews` because these read a different system: the
 * review *project* is ours, the analysis behind it is ART's.
 */

import { useQuery } from '@tanstack/react-query';
import { artService } from '../services/art-service';
import { useOrchestration } from './use-orchestration';
import { isOrchestrated } from '../services/snapshot-orchestration';
import type { ReviewResult } from '../models/review';

const keys = {
  aggregated: (botId: string, environmentUrl?: string) =>
    ['art-aggregated', botId, environmentUrl ?? 'current'] as const,
  linkContext: ['art-link-context'] as const,
};

/**
 * The reviewed agent and its connected agents, with scores where they exist.
 *
 * Held for five minutes: an ART review is a point-in-time artifact that only
 * changes when someone runs a new one, and each call fans out across
 * environments to resolve connected agents.
 *
 * An orchestrated snapshot needs no `botId`: it reads the assessments its own plan recorded, which
 * is what lets an uploaded skill — which has no bot record at all — report its review like any other
 * subject instead of showing an empty panel.
 */
export function useAggregatedReview(botId: string | undefined, environmentUrl?: string, result?: ReviewResult) {
  const orchestrated = isOrchestrated(result);
  const progress = useOrchestration(result);
  const assessments = progress.data?.progress?.assessments ?? [];
  const pointers = assessments.filter(item => item.stage === 'agent-review')
    .map(item => `${item.environmentId}:${item.agentId}:${item.status}:${item.resultId ?? ''}:${item.error ?? ''}`);
  return useQuery({
    queryKey: orchestrated ? ['art-snapshot', result?.id, environmentUrl, pointers] : keys.aggregated(botId ?? '', environmentUrl),
    queryFn: () => orchestrated
      ? artService.getSnapshotReview(result!.id, botId ?? '', environmentUrl ?? '', assessments)
      : artService.getAggregatedReview(botId ?? '', environmentUrl),
    enabled: orchestrated ? Boolean(progress.data) : Boolean(botId),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}

/**
 * Everything needed to link into the Agent Review Tool. None of it can change
 * while the app is loaded, so it is fetched once and kept.
 */
export function useArtLinkContext() {
  return useQuery({
    queryKey: keys.linkContext,
    queryFn: () => artService.linkContext(),
    staleTime: Infinity,
    retry: false,
  });
}
