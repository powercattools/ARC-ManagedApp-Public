/**
 * Result (snapshot) detail — Figma 8673:12290.
 *
 * A result is a point-in-time reading: one rule pack, one transcript window, one set of scores. Both the
 * static analysis and the runtime evidence hang off *this* page rather than off the review, because a
 * review accumulates snapshots that deliberately disagree with each other — that disagreement is the
 * progress the tool exists to show. Putting the evidence on the review would mean the newest run silently
 * rewrote the history of every earlier one.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Caption1,
  Skeleton,
  SkeletonItem,
  Title3,
  Toast,
  ToastBody,
  ToastTitle,
  Toaster,
  Tooltip,
  makeStyles,
  tokens,
  useId,
  useToastController,
} from '@fluentui/react-components';
import { ArrowLeftRegular, ArrowTrendingRegular, ClipboardTaskListLtrRegular } from '@fluentui/react-icons';
import { EmptyState } from '../../shared/components/EmptyState';
import { AnalysisPanel } from './components/AnalysisPanel';
import { ReviewAgainButton } from './components/ReviewAgainButton';
import { ShareResultsButton } from './components/ShareResultsButton';
import { SnapshotSwitcher } from './components/SnapshotSwitcher';
import { useReview, useReviewResult, useReviewResults } from './hooks/use-reviews';
import { isOrchestrated } from './services/snapshot-orchestration';
import { OrchestrationStatus } from './components/OrchestrationStatus';
import type { AssetType } from './models/review';

const useStyles = makeStyles({
  page: {
    padding: `${tokens.spacingVerticalL} ${tokens.spacingHorizontalXXL}`,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    width: '100%',
    maxWidth: '1337px',
    marginLeft: 'auto',
    marginRight: 'auto',
  },
  /**
   * Figma `8882:28392` is a single 56px bar: the title sits at the left edge and every command and
   * annotation is pushed to the right of it. The earlier two-row build let the bar wrap, which put
   * the annotations under the title where they read as a second heading rather than as a command bar.
   */
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalL,
    flexWrap: 'nowrap',
    minHeight: '56px',
    paddingBottom: tokens.spacingVerticalM,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  titleRow: { display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 },
  // The metadata reads as annotations on the command bar, not as commands, so it sits between the
  // share action and the primary one exactly as the design places it.
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: tokens.spacingHorizontalXS,
    flexWrap: 'nowrap',
    minWidth: 0,
    '& button': { flexShrink: 0, whiteSpace: 'nowrap' },
  },
  /**
   * Only the annotations give way.
   *
   * The two commands keep their places at the ends of the bar however narrow it gets; letting the
   * whole toolbar wrap instead put "Share results" in the middle of a line and stranded the primary
   * button on one of its own.
   */
  toolbarMeta: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    flexWrap: 'wrap',
    minWidth: 0,
    '& .fui-Badge': { whiteSpace: 'nowrap' },
  },
  divider: {
    width: '1px',
    alignSelf: 'stretch',
    backgroundColor: tokens.colorNeutralStroke2,
    marginLeft: tokens.spacingHorizontalXS,
    marginRight: tokens.spacingHorizontalXS,
  },
});

export default function ResultDetailPage() {
  const styles = useStyles();
  const navigate = useNavigate();
  const location = useLocation();
  const { reviewId = '', resultId = '' } = useParams();

  const review = useReview(reviewId);
  const result = useReviewResult(resultId);
  /**
   * Only for the count behind "View progress".
   *
   * Already in the cache — `SnapshotSwitcher` on this same header asks for it — so reading it here
   * costs nothing beyond the subscription.
   */
  const results = useReviewResults(reviewId);

  const backToReviews = useMemo(() => () => navigate('/reviews'), [navigate]);

  /**
   * Says once, on arrival, what the run left behind.
   *
   * Creating a review lands here rather than on a confirmation dialog, so the one thing that dialog
   * told the reader — that transcript analysis keeps running server-side after the snapshot is
   * saved — has to travel with them. An upload has no conversations of its own, so it is not
   * promised any.
   */
  const toasterId = useId('result-toaster');
  const { dispatchToast } = useToastController(toasterId);
  const announced = useRef(false);

  const justCreated = (location.state as { justCreated?: AssetType } | null)?.justCreated;
  /**
   * Nothing is announced until the snapshot itself is on screen.
   *
   * The `Toaster` lives in the loaded markup, and this page opens on a skeleton while the review and
   * its snapshot are still being fetched. Dispatching before that commit addresses a toaster that
   * does not exist yet, and the message is dropped on the floor — the arrival is announced to nobody.
   */
  const ready =
    !review.isPending && !result.isPending && Boolean(review.data) && Boolean(result.data);
  useEffect(() => {
    if (!ready || !justCreated || announced.current) return;
    announced.current = true;
    dispatchToast(
      <Toast>
        <ToastTitle>Review created</ToastTitle>
        <ToastBody>
          {justCreated === 'copilot-studio-agent'
            ? 'Runtime analysis of conversation transcripts continues in the background.'
            : 'The upload has been reviewed and the snapshot is saved.'}
        </ToastBody>
      </Toast>,
      // Long enough to read two lines before it goes; the default three seconds is not.
      { intent: 'success', timeout: 7000 },
    );
    // Dropped from history so navigating back to this snapshot later does not re-announce a run
    // that finished long ago.
    navigate(location.pathname, { replace: true, state: null });
  }, [dispatchToast, justCreated, location.pathname, navigate, ready]);

  if (review.isPending || result.isPending) {
    return (
      <main className={styles.page}>
        <Skeleton aria-label="Loading snapshot">
          <SkeletonItem size={32} />
          <div style={{ height: 16 }} />
          <SkeletonItem size={16} />
        </Skeleton>
      </main>
    );
  }

  if (review.isError || !review.data || result.isError || !result.data || result.data.reviewId !== reviewId) {
    return (
      <main className={styles.page}>
        <EmptyState
          icon={ClipboardTaskListLtrRegular}
          title="We couldn't load this snapshot"
          description="The result may have been deleted, or it belongs to a different review."
          action={
            <Button appearance="primary" onClick={backToReviews}>
              Back to reviews
            </Button>
          }
        />
      </main>
    );
  }

  const data = review.data;
  const snapshot = result.data;
  const hasProgress = (results.data?.length ?? 0) > 1;

  return (
    <main className={styles.page}>
      <Toaster toasterId={toasterId} />
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <Button
            appearance="subtle"
            icon={<ArrowLeftRegular />}
            aria-label="Back to reviews"
            onClick={backToReviews}
          />
          <Title3>Review Results #{snapshot.sequenceNumber}</Title3>
          <SnapshotSwitcher
            reviewId={data.id}
            current={snapshot}
            onSelect={id => navigate(`/reviews/${data.id}/results/${id}`)}
          />
        </div>

        <div className={styles.toolbar}>
          {/*
            One reading is not a trend. The button stays visible rather than disappearing, because
            its absence would read as a missing feature instead of a review that has only run once.

            `description`, not `label`: the button already says "View progress", and a labelling
            tooltip would replace that name for a screen reader with prose the button does not show.
            `disabledFocusable` for the same reason — a plainly disabled button takes no pointer or
            keyboard events, so the one sentence explaining why it is off would never be reachable.
          */}
          <Tooltip
            relationship="description"
            content={
              hasProgress
                ? 'See how the scores have moved across this review'
                : 'Available once this review has more than one result'
            }
          >
            <Button
              icon={<ArrowTrendingRegular />}
              disabledFocusable={!hasProgress}
              onClick={() =>
                navigate(`/reviews/${data.id}/progress`, { state: { from: snapshot.id } })
              }
            >
              View progress
            </Button>
          </Tooltip>
          <ShareResultsButton review={data} result={snapshot} />
          <div className={styles.divider} role="presentation" />
          <div className={styles.toolbarMeta}>
            {/*
              The rule pack and the AI-credit note were engine trivia on a bar a reader uses to
              place a snapshot in time. Neither told them anything they could act on, and both
              crowded out the one fact that does: when this ran.
            */}
            <Badge shape="rounded" appearance="ghost" color="informative">
              Created {new Date(snapshot.runTimestamp).toLocaleString()}
            </Badge>
            {snapshot.artifactFileName ? (
              <Badge shape="rounded" appearance="ghost" color="informative">
                Artifact {snapshot.artifactFileName} (version {snapshot.artifactVersion})
              </Badge>
            ) : null}
          </div>
          <ReviewAgainButton
            review={data}
            onCreated={created => navigate(`/reviews/${data.id}/results/${created.id}`)}
          />
        </div>
      </div>

      {isOrchestrated(snapshot) ? <OrchestrationStatus review={data} result={snapshot} /> : <Caption1>Legacy / unlinked snapshot: design analysis may show newer standalone reviews.</Caption1>}
      <AnalysisPanel review={data} result={snapshot} />
    </main>
  );
}
