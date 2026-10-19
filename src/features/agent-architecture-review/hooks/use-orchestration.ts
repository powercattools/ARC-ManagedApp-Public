import { useSyncExternalStore } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { snapshotProgress } from '../services/snapshot-progress';
import { isDrivingSnapshot, isOrchestrated, scheduleDeclarativeAgentSnapshot, scheduleSnapshot, scheduleUploadSnapshot, subscribeToDrivingSnapshots } from '../services/snapshot-orchestration';
import type { TargetRuntime, UploadedArtifact } from '../engine/scoring/art-ports';
import type { Review, ReviewResult } from '../models/review';
import type { AssessmentProgress, OrchestrationProgress } from '../models/orchestration';

/**
 * Whether an assessment has reached a state it will not leave, with its evidence reachable.
 *
 * The two stages point at different artifacts: an agent review is its `cat_agentreviews` row
 * (`resultId`), while runtime analysis is its job row (`jobId`). Requiring both would strand every
 * agent reviewed without a workflow job - deterministic-only reviews, and agents with no skills to
 * send - in a state the page polls forever and never reports as finished, which is what made a
 * snapshot show "0 of 4 assessments settled" while listing all four as succeeded.
 */
export function assessmentTerminal(item: AssessmentProgress): boolean {
  if (item.status === 'failed') return true;
  if (item.status !== 'succeeded' && item.status !== 'no-data') return false;
  return Boolean(item.stage === 'runtime' ? item.jobId : item.resultId);
}

/** Completion is published only after terminal assessments and their artifact pointers are persisted. */
export function orchestrationTerminal(progress: OrchestrationProgress | undefined): boolean {
  if (!progress) return false;
  if (progress.status === 'failed') return true;
  return (progress.status === 'completed' || progress.status === 'completed-with-gaps') &&
    progress.assessments.length > 0 &&
    progress.assessments.every(assessmentTerminal);
}

export type OrchestrationPhase = 'loading' | 'not-scheduled' | 'in-progress' | 'needs-attention' | 'complete' | 'stopped';

export function orchestrationPhase(progress: OrchestrationProgress | undefined, loading: boolean): OrchestrationPhase {
  if (!progress) return loading ? 'loading' : 'not-scheduled';
  if (progress.status === 'failed') return 'stopped';
  if (progress.status === 'needs-attention') return 'needs-attention';
  return orchestrationTerminal(progress) ? 'complete' : 'in-progress';
}

/**
 * Only transcript analysis and the three workflow-backed AI stages advance with the tab closed.
 * Assembly and scoring still run outside Dataverse, so no phase may promise unattended completion.
 */
export const PHASE_PROMISE: Record<OrchestrationPhase, string> = {
  loading: 'Reading the saved status of this snapshot.',
  'not-scheduled': 'This saved snapshot has no review request yet. Retry scheduling this same snapshot; do not create another one.',
  'in-progress': 'Closing this tab loses no work: transcript analysis and workflow-backed assessments keep running on the server. Assembling and scoring the review runs here, so reopen this snapshot to finish it.',
  'needs-attention': 'This snapshot cannot continue until the original requester acts. Resuming under a different account is not a substitute.',
  complete: 'Every assessment reached a terminal state and its artifact pointers are saved.',
  stopped: 'Generation stopped for this snapshot. It keeps its history and its explanation; no score is inferred from partial work.',
};

/** Observe saved state only. React Query serializes polling and cancels it when the view unmounts. */
export function useOrchestration(result: ReviewResult | undefined) {
  return useQuery({
    queryKey: ['review-orchestration', result?.id],
    // The snapshot's own window bounds what runtime analysis could ever find, which is what lets a
    // snapshot with nothing to analyse report itself finished instead of polling forever.
    queryFn: async () => ({
      progress: await snapshotProgress(result!.id, {
        start: result!.transcriptStart,
        end: result!.transcriptEnd,
      }),
    }),
    enabled: isOrchestrated(result),
    refetchInterval: query => orchestrationTerminal(query.state.data?.progress) ? false : 5000,
    staleTime: 2000,
    retry: false,
  });
}

/** An explicit user action may re-submit the same idempotent request, never launch browser workers. */
export function useScheduleSnapshot(review: Review, result: ReviewResult, onSaved: () => void) {
  return useMutation({
    mutationFn: () => scheduleSnapshot(review, result),
    onSuccess: onSaved,
  });
}

/**
 * Whether this tab is the one running the snapshot right now.
 *
 * An unsettled snapshot looks identical whether it is mid-flight or abandoned — a review waiting on
 * its workflow writes nothing for minutes — so the saved rows cannot answer this and only the tab
 * doing the work can. Offering to resume a run that is already going would have two drivers writing
 * the same agent.
 */
export function useIsDrivingSnapshot(snapshotId: string | undefined): boolean {
  return useSyncExternalStore(
    subscribeToDrivingSnapshots,
    () => isDrivingSnapshot(snapshotId),
  );
}

/**
 * Resume a saved upload snapshot by supplying its artifact again.
 *
 * The upload path cannot reuse {@link useScheduleSnapshot}: an agent snapshot names an agent the
 * engine can read back, whereas an upload's bytes live only in the dialog that chose them and are
 * never persisted. Resuming therefore has to ask for the file, which is why this takes an artifact
 * where the agent version takes nothing.
 *
 * The run itself is still a resume rather than a repeat — it targets the saved snapshot id, so a
 * skill whose job already finished is re-attached to it instead of being reviewed a second time.
 *
 * Both kinds of upload resume here, because both have the same problem: the bytes are gone. Which
 * run to schedule follows from which field the field produced, and nothing else.
 */
export function useResumeUploadSnapshot(result: ReviewResult, onSaved: () => void) {
  return useMutation({
    mutationFn: (selection: { artifact?: UploadedArtifact; declarativeAgent?: File; runtimes: TargetRuntime[] }) => {
      if (selection.declarativeAgent) return scheduleDeclarativeAgentSnapshot(result, selection.declarativeAgent);
      if (!selection.artifact) throw new Error('Choose the file again to resume this snapshot.');
      return scheduleUploadSnapshot(result, selection.artifact, selection.runtimes);
    },
    onSuccess: onSaved,
  });
}
