/**
 * React Query bindings for the review feature.
 *
 * Components never call the services directly — they go through these hooks, so
 * caching, invalidation and the loading/error contract live in one place.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { isOrchestrated, scheduleSnapshot, scheduleUploadSnapshot, scheduleDeclarativeAgentSnapshot } from '../services/snapshot-orchestration';
import { reviewService, type ReviewFilters } from '../services/review-service';
import { environmentService } from '../services/environment-service';
import type { CreatedReview, CreateReviewInput, ReviewAgainInput, ReviewResult } from '../models/review';
import type { SnapshotProgress } from '../engine/contracts/review-progress';

const keys = {
  reviews: (filters: ReviewFilters) => ['reviews', filters] as const,
  review: (id: string) => ['review', id] as const,
  results: (id: string) => ['review-results', id] as const,
  result: (id: string) => ['review-result', id] as const,
  environments: ['environments'] as const,
  agents: (environmentUrl?: string) => ['agents', environmentUrl ?? 'all'] as const,
};

export function useReviews(filters: ReviewFilters) {
  return useQuery({
    queryKey: keys.reviews(filters),
    queryFn: () => reviewService.listReviews(filters),
  });
}

export function useReview(id: string) {
  return useQuery({
    queryKey: keys.review(id),
    queryFn: () => reviewService.getReview(id),
    enabled: Boolean(id),
  });
}

export function useReviewResults(id: string) {
  return useQuery({
    queryKey: keys.results(id),
    queryFn: () => reviewService.listResults(id),
    enabled: Boolean(id),
  });
}

/** One snapshot, for the result detail page. */
export function useReviewResult(id: string) {
  return useQuery({
    queryKey: keys.result(id),
    queryFn: () => reviewService.getResult(id),
    enabled: Boolean(id),
  });
}

/**
 * Every environment the connection can reach, unfiltered — the same set the
 * Agent Review Tool shows, and no role check is applied to any of them. See the
 * header of `environment-service.ts`.
 *
 * One call, and the answer changes rarely, so it is held for the session.
 */
export function useEnvironments() {
  return useQuery({
    queryKey: keys.environments,
    queryFn: () => environmentService.listEnvironments(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
}

/**
 * Agents in one environment.
 *
 * A user without access to the environment gets a failed read here, surfaced as
 * the query's error state — the same way ART reports it.
 */
export function useAgents(environmentUrl?: string) {
  return useQuery({
    queryKey: keys.agents(environmentUrl),
    queryFn: () => environmentService.listAgents(environmentUrl),
    enabled: Boolean(environmentUrl),
    staleTime: 5 * 60 * 1000,
  });
}

export function useCreateReview() {
  const queryClient = useQueryClient();
  const saved = useRef<CreatedReview | undefined>(undefined);
  const [savedSnapshot, setSavedSnapshot] = useState<CreatedReview>();
  const [progress, setProgress] = useState<SnapshotProgress>();
  const mutation = useMutation({
    mutationFn: async (input: CreateReviewInput) => {
      const created = saved.current ?? await reviewService.createReview(input);
      if (isOrchestrated(created.result)) {
        saved.current = created;
        setSavedSnapshot(created);
        // Three kinds of subject, three runs. An upload carries its own skills, a declarative agent
        // package carries exactly one agent graded on its own rubric, and an agent snapshot expands
        // a graph from a bot id. They share a progress contract and nothing else, so the branch is
        // here rather than inside a run that would have to ignore most of its inputs.
        if (input.declarativeAgent) {
          await scheduleDeclarativeAgentSnapshot(created.result, input.declarativeAgent, setProgress);
        } else if (input.artifact) {
          await scheduleUploadSnapshot(created.result, input.artifact, input.runtimes ?? [], setProgress);
        } else {
          await scheduleSnapshot(created.review, created.result, setProgress);
        }
      }
      saved.current = undefined;
      setSavedSnapshot(undefined);
      return created;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
    },
  });
  return { ...mutation, savedSnapshot, progress, reset: () => {
    saved.current = undefined;
    setSavedSnapshot(undefined);
    setProgress(undefined);
    mutation.reset();
  } };
}

export function useReviewAgain(reviewId: string) {
  const queryClient = useQueryClient();
  const saved = useRef<ReviewResult | undefined>(undefined);
  const [savedSnapshot, setSavedSnapshot] = useState<ReviewResult>();
  const [progress, setProgress] = useState<SnapshotProgress>();
  const mutation = useMutation({
    mutationFn: async (input: ReviewAgainInput = {}) => {
      const created = saved.current?.reviewId === reviewId ? saved.current : await reviewService.reviewAgain(reviewId, input);
      if (isOrchestrated(created)) {
        saved.current = created;
        setSavedSnapshot(created);
        const review = await reviewService.getReview(reviewId);
        if (!review) throw new Error(`Snapshot ${created.id} is saved but its review could not be read. Retry scheduling this snapshot.`);
        // An upload is graded from the bytes just handed over; an agent is re-read from its
        // environment. The three share a progress contract and nothing else.
        if (input.declarativeAgent) {
          await scheduleDeclarativeAgentSnapshot(created, input.declarativeAgent, setProgress);
        } else if (input.artifact) {
          await scheduleUploadSnapshot(created, input.artifact, input.runtimes ?? [], setProgress);
        } else {
          await scheduleSnapshot(review, created, setProgress);
        }
      }
      saved.current = undefined;
      setSavedSnapshot(undefined);
      return created;
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: keys.results(reviewId) });
      void queryClient.invalidateQueries({ queryKey: keys.review(reviewId) });
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
    },
  });
  return { ...mutation, savedSnapshot, progress, reset: () => {
    saved.current = undefined;
    setSavedSnapshot(undefined);
    setProgress(undefined);
    mutation.reset();
  } };
}
