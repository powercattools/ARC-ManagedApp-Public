/**
 * React Query bindings for the agent runtime analysis.
 *
 * Everything here is scoped to a **review result** (a snapshot), never to the review. A snapshot covers
 * one date range at one moment; showing another snapshot's numbers against it would silently misreport
 * what was measured.
 *
 * The run itself is a long server-side job, so this is a poll loop rather than a request. The loop owns
 * one responsibility the service cannot: deciding that a job has stopped and telling the user so. A
 * parked job is **not** woken automatically. Dataverse caps how many chunks the plugin may chain, so a
 * large agent parks itself by design; continuing is offered as a choice rather than taken silently,
 * because the alternative — an invisible loop driven by whichever tab happens to be open — is exactly
 * what made an interrupted run indistinguishable from a finished one.
 */

import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { runtimeService, type StartAnalysisInput } from '../services/runtime-service';
import { RuntimeJobStatus, type RuntimeJob } from '../models/runtime';
import { useOrchestration } from './use-orchestration';
import { isOrchestrated } from '../services/snapshot-orchestration';
import type { ReviewResult } from '../models/review';
import type { AssessmentProgress } from '../models/orchestration';

const POLL_INTERVAL_MS = 2_500;

/**
 * How long a job may sit on `Running` without a write before it is treated as stopped.
 *
 * The plugin writes its chunk log, cursor and status at the end of every chunk, so silence for this
 * long means the chain died rather than that it is busy. Generous by design: a chunk of 500
 * transcripts is seconds of work, so ten minutes cannot be mistaken for one that is merely slow.
 */
const STALL_AFTER_MS = 10 * 60_000;
export const STALL_AFTER_MINUTES = STALL_AFTER_MS / 60_000;

/**
 * Whether a job on `Running` has gone quiet long enough to be treated as stopped.
 *
 * Exported for its own tests: the judgement it encodes - that silence means death, not slowness - is
 * the part worth pinning down, and it needs no React to exercise.
 *
 * A row with no timestamp, or an unparseable one, is never called stalled. Offering to continue a job
 * that is merely working would start a second chain over the same cursor.
 */
export function hasStalled(job: RuntimeJob): boolean {
  const at = job.modifiedOn ? Date.parse(job.modifiedOn) : Number.NaN;
  return Number.isFinite(at) && Date.now() - at > STALL_AFTER_MS;
}

const keys = {
  preflight: (agentId: string, environmentUrl: string, rangeStart: string, rangeEnd: string) =>
    ['runtime-preflight', agentId, environmentUrl, rangeStart, rangeEnd] as const,
  forResult: (resultId: string) => ['runtime-result', resultId] as const,
  allForResult: (resultId: string) => ['runtime-result-all', resultId] as const,
  inFlight: (resultId: string) => ['runtime-inflight', resultId] as const,
  assessment: (resultId: string | undefined, agentId: string | undefined, assessment?: AssessmentProgress) =>
    ['runtime-assessment', resultId, agentId, assessment?.jobId, assessment?.resultId, assessment?.status] as const,
};

/**
 * Whether a cached query holds runtime state for this result. Readers key on more than the result
 * id - the single-agent view appends the agent id, the orchestrated view keys on the assessment -
 * so a finished chunk cannot be published by writing one exact key. Every runtime key carries the
 * result id second, which is enough to find them all.
 *
 * `runtime-preflight` is deliberately not matched: it keys on the agent, not the result, and what
 * it reports (how much there is to analyse) does not change when a chunk completes.
 */
export function isRuntimeQueryFor(queryKey: readonly unknown[], resultId: string): boolean {
  const [head, id] = queryKey;
  return typeof head === 'string' && head.startsWith('runtime-') && head !== 'runtime-preflight' && id === resultId;
}

/**
 * Whether a run can be offered for this agent, and the reason when it cannot.
 *
 * `environmentUrl` is part of the key because the verdict changes with it: the same agent is
 * analysable from its own environment and not from anywhere else. The dates are in the key for the
 * same reason — the verdict now counts transcripts inside them, so moving a picker re-asks.
 */
export function useRuntimePreflight(
  agentId: string | undefined,
  environmentUrl?: string,
  rangeStart?: string,
  rangeEnd?: string,
) {
  return useQuery({
    queryKey: keys.preflight(agentId ?? '', environmentUrl ?? '', rangeStart ?? '', rangeEnd ?? ''),
    queryFn: () => runtimeService.preflight(agentId ?? '', environmentUrl, { start: rangeStart, end: rangeEnd }),
    enabled: Boolean(agentId),
    staleTime: 60 * 1000,
    // The Dataverse connector intermittently refuses a request it served moments earlier, and the
    // verdict gates a dialog, so one retry is the difference between a usable form and a dead end.
    retry: 1,
  });
}

/** The completed analysis behind a snapshot. */
export function useResultRuntimeReport(resultId: string | undefined, agentId?: string, snapshot?: ReviewResult) {
  const orchestrated = isOrchestrated(snapshot);
  const progress = useOrchestration(snapshot);
  const assessment = progress.data?.progress?.assessments.find(item => item.stage === 'runtime' && item.agentId === agentId);
  return useQuery({
    queryKey: orchestrated ? keys.assessment(resultId, agentId, assessment) : [...keys.forResult(resultId ?? ''), agentId],
    queryFn: async () => (orchestrated
      ? assessment ? await runtimeService.forAssessment(resultId ?? '', assessment) : null
      : await runtimeService.forResult(resultId ?? '', agentId)) ?? null,
    enabled: Boolean(resultId),
    staleTime: orchestrated ? Infinity : 30 * 1000,
    retry: false,
  });
}

/**
 * Every completed analysis under a snapshot, keyed by agent.
 *
 * The Runtime tab only ever shows the reviewed agent, but the shared report covers connected agents too,
 * so this cannot reuse `useResultRuntimeReport` — that one deliberately takes the single newest row.
 */
export function useAllResultRuntime(resultId: string | undefined, enabled = true, snapshot?: ReviewResult) {
  const queryClient = useQueryClient();
  const orchestrated = isOrchestrated(snapshot);
  const progress = useOrchestration(snapshot);
  const assessments = progress.data?.progress?.assessments.filter(item => item.stage === 'runtime') ?? [];
  return useQuery({
    queryKey: orchestrated ? ['runtime-snapshot-all', resultId, assessments] : keys.allForResult(resultId ?? ''),
    queryFn: async () => {
      // A run parked at the chunk cap carries a real cumulative report, so the shared report has to
      // include it: requiring "Keep these results" first silently dropped runtime evidence that the
      // Runtime tab was already showing.
      const snapshotJobs = await runtimeService.allForResult(resultId ?? '', { includeParked: true });
      const accepted = orchestrated
        ? (await Promise.all(assessments.map(item => queryClient.fetchQuery({
          queryKey: keys.assessment(resultId, item.agentId, item),
          queryFn: async () => await runtimeService.forAssessment(resultId ?? '', item) ?? null,
          staleTime: Infinity,
          retry: false,
        })))).filter((job): job is RuntimeJob => Boolean(job))
        : [];
      // Accepted evidence is bound to its assessment, so it wins for the agents it covers and the
      // snapshot-bound rows only fill in the rest. Keyed lower-case because `botId` casing comes from
      // the Power Apps SDK while `agentId` comes from Dataverse.
      const byAgent = new Map<string, RuntimeJob>();
      for (const job of [...snapshotJobs, ...accepted]) {
        if (job.agentId) byAgent.set(job.agentId.toLowerCase(), job);
      }
      return byAgent;
    },
    enabled: Boolean(resultId) && enabled,
    staleTime: 30 * 1000,
    retry: false,
  });
}

export interface RuntimeRunState {
  job?: RuntimeJob;
  isRunning: boolean;
  error?: string;
  start: (input: StartAnalysisInput) => void;
  isStarting: boolean;
  /** True when the job stopped short of finishing and can be picked up again. */
  canContinue: boolean;
  /** Why it stopped: parked at the chunk limit, or stopped writing altogether. */
  continueReason?: 'paused' | 'stalled';
  continueRun: () => void;
  isContinuing: boolean;
  /** Accepts what a parked run has already analysed as the snapshot's evidence. */
  finishRun: () => void;
  isFinishing: boolean;
}

/**
 * Reads a parked job whole, so the work it has already done is not lost behind a Continue button.
 *
 * The poll loop deliberately omits the report — it can reach 1 MB and is re-read every few seconds —
 * but the plugin writes the cumulative report on *every* chunk, parked ones included. Polling alone
 * therefore leaves a complete answer for tens of thousands of conversations sitting unread in
 * Dataverse while the user is told only that there is more to do. On a busy agent that is several
 * rounds of clicking Continue with nothing to show for any of them.
 *
 * A failed read falls back to the polled row: losing the report is much better than losing the parked
 * job itself, which is what tells the user anything happened at all.
 */
async function readWithReport(jobId: string, polled: RuntimeJob): Promise<RuntimeJob> {
  try {
    return await runtimeService.read(jobId);
  } catch {
    return polled;
  }
}

/**
 * Starts a run and follows it to a terminal state, rejoining one already in flight.
 *
 * Rejoining matters because the analysis is queued when a snapshot is created and routinely outlives the
 * dialog that started it. Without it, a user who navigates away and returns sees an empty Runtime tab
 * and starts a second run over the same transcripts.
 *
 * A parked job is surfaced, not resumed. The plugin can only chain a few executions before Dataverse
 * stops it, so it parks as `Paused` and waits; `continueRun` writes `Running`, which starts a fresh
 * chain. Writing `Paused` back would re-enter the exhausted chain and stall the run permanently, so the
 * status written is deliberately not the status that was read.
 */
export function useRuntimeAnalysis(
  resultId: string | undefined,
  agentId: string | undefined,
): RuntimeRunState {
  const queryClient = useQueryClient();
  const [jobId, setJobId] = useState<string>();
  const [job, setJob] = useState<RuntimeJob>();
  const [error, setError] = useState<string>();

  // The job the user can pick up again, held separately from `jobId` so that parking stops the poll
  // loop: a parked job makes no progress, and polling it would be noise until someone acts.
  const [paused, setPaused] = useState<{ job: RuntimeJob; reason: 'paused' | 'stalled' }>();
  const [continuing, setContinuing] = useState(false);
  const [finishing, setFinishing] = useState(false);

  const inFlight = useQuery({
    queryKey: keys.inFlight(resultId ?? ''),
    queryFn: () => runtimeService.inFlightForResult(resultId ?? '', agentId),
    enabled: Boolean(resultId),
    staleTime: 0,
    retry: false,
  });

  // Adopt a run that was already going when this view mounted. A job found parked is surfaced
  // directly rather than polled: polling it would show a progress spinner for a run that is making
  // none, and would hide the report it has already written until the first poll came back.
  const adopted = inFlight.data;
  useEffect(() => {
    if (jobId || paused || !adopted?.id) return;
    if (adopted.status === RuntimeJobStatus.Paused || hasStalled(adopted)) {
      setPaused({
        job: adopted,
        reason: adopted.status === RuntimeJobStatus.Paused ? 'paused' : 'stalled',
      });
      return;
    }
    setJobId(adopted.id);
    setJob(adopted);
  }, [adopted, jobId, paused]);

  const start = useMutation({
    mutationFn: (input: StartAnalysisInput) => runtimeService.start(input),
    onMutate: () => {
      setError(undefined);
      setJob(undefined);
      setPaused(undefined);
    },
    onSuccess: (created) => {
      setJobId(created.id);
      setJob(created);
    },
    onError: (err: Error) => setError(err.message),
  });

  useEffect(() => {
    if (!jobId) return;

    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const current = await runtimeService.poll(jobId);
        if (cancelled) return;
        setJob(current);

        if (current.status === RuntimeJobStatus.Paused) {
          setPaused({ job: await readWithReport(jobId, current), reason: 'paused' });
          setJobId(undefined);
          return;
        }

        // A chain that died mid-chunk never writes `Paused` - it just stops, leaving the row on
        // `Running` for good. Only the clock tells the two apart, so silence is read as a stop.
        if (current.status === RuntimeJobStatus.Running && hasStalled(current)) {
          setPaused({ job: await readWithReport(jobId, current), reason: 'stalled' });
          setJobId(undefined);
          return;
        }

        if (current.status === RuntimeJobStatus.Succeeded) {
          const full = await runtimeService.read(jobId);
          if (cancelled) return;
          setJob(full);
          setJobId(undefined);
          if (resultId) {
            void queryClient.invalidateQueries({ predicate: query => isRuntimeQueryFor(query.queryKey, resultId) });
          }
          return;
        }

        if (current.status === RuntimeJobStatus.Failed) {
          setError(describeFailure(current));
          setJobId(undefined);
        }
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message);
        setJobId(undefined);
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [jobId, resultId, queryClient]);

  const startRun = useCallback(
    (input: StartAnalysisInput) => {
      start.mutate(input);
    },
    [start],
  );

  const continueRun = useCallback(() => {
    const target = paused?.job;
    if (!target || continuing) return;

    setContinuing(true);
    setError(undefined);
    void (async () => {
      try {
        await runtimeService.resume(target.id);
        setPaused(undefined);
        // Re-arming the poll loop is what makes the next chunk visible; the write above only starts it.
        setJobId(target.id);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setContinuing(false);
      }
    })();
  }, [paused, continuing]);

  const finishRun = useCallback(() => {
    const target = paused?.job;
    if (!target || finishing) return;

    setFinishing(true);
    setError(undefined);
    void (async () => {
      try {
        await runtimeService.accept(target.id);
        // Kept in `job` rather than `paused`, so the Continue banner clears and the report below it
        // becomes this snapshot's answer instead of an interim one.
        setJob({ ...target, status: RuntimeJobStatus.Succeeded });
        setPaused(undefined);
        if (resultId) {
          void queryClient.invalidateQueries({ predicate: query => isRuntimeQueryFor(query.queryKey, resultId) });
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setFinishing(false);
      }
    })();
  }, [paused, finishing, resultId, queryClient]);

  return {
    job: job ?? paused?.job,
    isRunning: Boolean(jobId),
    error,
    start: startRun,
    isStarting: start.isPending,
    canContinue: Boolean(paused),
    continueReason: paused?.reason,
    continueRun,
    isContinuing: continuing,
    finishRun,
    isFinishing: finishing,
  };
}

/**
 * Turns the plugin's failure kind into something the user can act on. The kind matters more than the
 * raw message: a privilege failure is somebody else's job to fix, and saying so saves a support round trip.
 */
function describeFailure(job: RuntimeJob): string {
  switch (job.errorKind) {
    case 'NoPrivilege':
      return 'The analysis could not read conversation transcripts. Your account needs Read privileges on the Conversation Transcript table in this environment.';
    case 'NoAgent':
      return 'The analysis could not resolve the agent. It may have been deleted, or it may live in a different environment.';
    default:
      return job.errorMessage ?? 'The runtime analysis failed.';
  }
}
