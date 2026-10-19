/**
 * The "Review again" command, with everything a new run needs behind it.
 *
 * Re-reviewing is one action with two pieces of UI — the window/artifact dialog and the save
 * progress — so it lives in one component rather than being re-assembled by every page that offers
 * it. The result header and the review header both show it (Figma `8959:21674`).
 *
 * Failures are left to the dialog, which stays open and shows them against the input that caused
 * them; that is where the reader already is.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  Button,
  Spinner,
  Toast,
  ToastTitle,
  Toaster,
  useId,
  useToastController,
} from '@fluentui/react-components';
import { ArrowSyncRegular } from '@fluentui/react-icons';
import { ReviewAgainDialog } from './ReviewAgainDialog';
import { SnapshotProgressDialog } from './SnapshotProgressDialog';
import { useReviewAgain, useReviewResults } from '../hooks/use-reviews';
import { isUploadAssetType, type Review, type ReviewAgainInput, type ReviewResult } from '../models/review';
import { logReviewAction } from '../services/review-telemetry';

export interface ReviewAgainButtonProps {
  review: Review;
  /** Called once the snapshot exists, so a page can navigate to it. */
  onCreated?: (created: ReviewResult) => void;
}

export function ReviewAgainButton({ review, onCreated }: ReviewAgainButtonProps) {
  const toasterId = useId('review-again-toaster');
  const { dispatchToast } = useToastController(toasterId);

  const [rangeDialogOpen, setRangeDialogOpen] = useState(false);

  const results = useReviewResults(review.id);
  const reviewAgain = useReviewAgain(review.id);

  const needsUpload = isUploadAssetType(review.assetType);

  /**
   * The subject the newest snapshot reviewed, so a re-upload that turns out to be a different skill
   * can be warned about rather than silently charted as progress (spec 015 harness-skill § 6.2).
   *
   * Only the id is persisted, so the display name is derived from it: ids are namespaced
   * (`skill:order-resolution-concierge`) and the prefix is noise to a reader.
   */
  const priorSubject = useMemo(() => {
    let newest: ReviewResult | undefined;
    for (const result of results.data ?? []) {
      if (!newest || result.sequenceNumber > newest.sequenceNumber) newest = result;
    }
    const id = newest?.subjectId;
    return id ? { id, name: id.replace(/^skill:/, '') } : undefined;
  }, [results.data]);

  /**
   * Produces the snapshot.
   *
   * The run it schedules is a server-side job that routinely takes minutes, so the dialog closes as
   * soon as the snapshot exists rather than waiting on it. The Runtime tab rejoins the run when it
   * is opened.
   */
  const runReviewAgain = useCallback(
    (input: ReviewAgainInput) => {
      // Report the accepted Review-again to telemetry, but never for a saved-snapshot retry.
      // Fire-and-forget: the call can never block or fail the run.
      if (!reviewAgain.savedSnapshot) {
        logReviewAction('review-again', review.assetType, null);
      }
      reviewAgain.mutate(input, {
        onSuccess: created => {
          setRangeDialogOpen(false);

          dispatchToast(
            <Toast>
              <ToastTitle>Snapshot #{created.sequenceNumber} created</ToastTitle>
            </Toast>,
            { intent: 'success' },
          );

          onCreated?.(created);
        },
      });
    },
    [dispatchToast, onCreated, review.assetType, reviewAgain],
  );

  /**
   * While the snapshot runs, the form behind it has nothing left to offer and the run is the only
   * thing worth showing, so the two never overlap (the same rule `NewReviewDialog` follows).
   *
   * `savedSnapshot` is set the moment the snapshot row exists, which is also the moment the engine
   * starts. It stays set when scheduling fails, and `isPending` does not — which is what brings the
   * form back, carrying its error and its retry.
   */
  const runInProgress = reviewAgain.isPending && Boolean(reviewAgain.savedSnapshot);

  return (
    <>
      <Toaster toasterId={toasterId} />

      <Button
        appearance="primary"
        icon={reviewAgain.isPending ? <Spinner size="tiny" /> : <ArrowSyncRegular />}
        disabled={reviewAgain.isPending}
        // One dialog for both, because the only difference is what it asks for: an upload asks for a
        // new artifact, an agent for a transcript window.
        onClick={() => setRangeDialogOpen(true)}
      >
        Review again
      </Button>

      <ReviewAgainDialog
        open={rangeDialogOpen && !runInProgress}
        onOpenChange={open => {
          setRangeDialogOpen(open);
          if (!open) reviewAgain.reset();
        }}
        agentId={review.botId}
        needsUpload={needsUpload}
        priorSubjectId={priorSubject?.id}
        priorSubjectName={priorSubject?.name}
        isRunning={reviewAgain.isPending}
        savedSnapshotNumber={reviewAgain.savedSnapshot?.sequenceNumber}
        error={reviewAgain.isError ? reviewAgain.error.message : undefined}
        onRun={runReviewAgain}
      />

      <SnapshotProgressDialog
        open={runInProgress}
        title={review.botName ?? review.projectName}
        progress={reviewAgain.progress}
      />
    </>
  );
}
