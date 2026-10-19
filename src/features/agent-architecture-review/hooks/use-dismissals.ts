/**
 * The reviewer's "Ignore this rule" decisions for the snapshot on screen.
 *
 * Loads them, records changes, and hands the score back the set of keys to honour. It decides
 * nothing about what a dismissal is worth — that is the rubric's, reached through `art-ports`. The
 * caller passes `revise` to say what the decisions are worth, which is what lets this record the
 * revised score without ever learning how one is arrived at.
 *
 * Writes are optimistic. The score and the row change the moment the button is pressed, because a
 * button that appears to do nothing for a second is a button people press twice; if the write then
 * fails the previous list is put back and the reason is surfaced, so the screen is never quietly
 * showing a decision the environment did not keep.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getHostContext } from '../../../data';

import { readDismissals, writeDismissals } from '../services/dismissal-store';
import { cacheSnapshotScore } from '../services/score-cache';
import {
  dismissedKeys,
  withDismissal,
  withoutDismissal,
  type RuleDismissal,
} from '../engine/scoring/art-ports';

/**
 * What a set of decisions is worth, as the rubric sees it.
 *
 * Both numbers are cached so every surface reads one answer. The agent's own score is what its
 * button and the per-agent line of a shared report show; the rollup is what the home grid and that
 * report's headline show. Writing only one of them leaves the two disagreeing on the same snapshot.
 */
export interface RevisedScores {
  /** The selected agent's score with these decisions applied. */
  agent: number | null;
  /** The snapshot's score across every agent it covers, with this agent's revision folded in. */
  rollup: number | null;
}

export interface DismissalState {
  dismissals: readonly RuleDismissal[];
  /** What scoring and the consolidated view take. */
  keys: ReadonlySet<string>;
  /** A write is in flight. */
  busy: boolean;
  /** Why the last write failed, when one did. */
  error?: string;
  /**
   * Set aside the given rule instances, or reinstate them.
   *
   * Undefined when the snapshot or agent is not yet known, which is what hides the control rather
   * than offering a button with nowhere to write.
   */
  setAside?: (keys: readonly string[], setAside: boolean) => void;
}

/**
 * The stored list, or none when there is no agent selected yet.
 *
 * Always async, so the caller's effect never sets state in the same tick it renders in — the
 * no-agent case has to defer too, or clearing the list becomes a cascading render.
 */
async function loadFor(
  snapshotId: string | undefined,
  agentId: string | undefined,
): Promise<readonly RuleDismissal[]> {
  if (!snapshotId || !agentId) return [];
  return readDismissals(snapshotId, agentId);
}

export function useDismissals(
  snapshotId?: string,
  agentId?: string,
  revise?: (keys: ReadonlySet<string>) => RevisedScores | undefined,
): DismissalState {
  const [dismissals, setDismissals] = useState<readonly RuleDismissal[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const queryClient = useQueryClient();

  /**
   * Held by reference so a caller can rebuild the callback on every render — which it will, since
   * it closes over the review being shown — without that churn rebuilding `setAside` and, through
   * it, every row that takes it.
   */
  const reviseRef = useRef(revise);
  useEffect(() => {
    reviseRef.current = revise;
  });

  // Who pressed the button, resolved once. A dismissal without an author is still a valid decision,
  // so failing to resolve it is not an error — the record simply does not name anyone.
  const author = useRef<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const context = await getHostContext();
        if (!cancelled) author.current = context.user.fullName;
      } catch {
        // Left unnamed.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await loadFor(snapshotId, agentId);
      if (!cancelled) setDismissals(stored);
    })();
    return () => { cancelled = true; };
  }, [snapshotId, agentId]);

  const setAside = useCallback(
    (keys: readonly string[], on: boolean) => {
      if (!snapshotId || !agentId) return;

      const previous = dismissals;
      const dismissedOn = new Date().toISOString();
      const next = keys.reduce<readonly RuleDismissal[]>(
        (list, key) => on
          ? withDismissal(list, {
              key,
              // A key always begins with its rule id; the component id, if any, follows a colon.
              ruleId: key.split(':')[0],
              dismissedOn,
              ...(author.current ? { dismissedBy: author.current } : {}),
            })
          : withoutDismissal(list, key),
        previous,
      );

      setDismissals(next);
      setBusy(true);
      setError(undefined);

      // Scored from the keys about to be written rather than from this hook's state, which has not
      // re-rendered yet. Reading the number currently on screen would cache the score from before
      // the button was pressed, leaving the stored copy permanently one decision behind.
      const revised = reviseRef.current?.(dismissedKeys(next));

      void writeDismissals(snapshotId, agentId, next, revised?.agent)
        .then(
          () => {
            // The agent's own score was written alongside the decision, so anything serving that
            // row from cache — the per-agent line of a shared report — is now a decision behind.
            void queryClient.invalidateQueries({ queryKey: ['snapshot-agent-scores', snapshotId] });
            if (!revised) return undefined;
            // The decision and the agent's own score are already stored together. A rollup that
            // fails to write leaves the review list one decision behind rather than losing the
            // decision, so it is reported without putting the list back: rolling back here would
            // tell the reviewer their judgement was discarded when the environment is holding it.
            return cacheSnapshotScore(snapshotId, revised.rollup).then(
              () => {
                // The snapshot's own score moved, and it is what the review list shows and what a
                // shared report prints as its headline.
                void queryClient.invalidateQueries({ queryKey: ['review-result', snapshotId] });
                void queryClient.invalidateQueries({ queryKey: ['reviews'] });
              },
              () => {
                setError('The decision was saved. The review list may show the previous score until this review is opened again.');
              },
            );
          },
          (cause: unknown) => {
            setDismissals(previous);
            setError(cause instanceof Error ? cause.message : 'The decision could not be saved.');
          },
        )
        .finally(() => setBusy(false));
    },
    [snapshotId, agentId, dismissals, queryClient],
  );

  const keys = useMemo(() => dismissedKeys(dismissals), [dismissals]);

  return {
    dismissals,
    keys,
    busy,
    error,
    setAside: snapshotId && agentId ? setAside : undefined,
  };
}
