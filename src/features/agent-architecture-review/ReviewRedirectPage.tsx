/**
 * `/reviews/:reviewId` — resolves a review to the snapshot worth reading.
 *
 * There used to be a page here listing the review's snapshots, which every reader had to click
 * through to reach the result they had just asked for. The list now lives under the progress chart
 * where it earns its place, and this route resolves to the newest snapshot instead — so links and
 * bookmarks written against the old address still land somewhere honest rather than on a 404.
 *
 * The one thing the old page did that nothing else did was offer to run a review that had never
 * produced a snapshot. That is kept, because a review with no results genuinely has nothing to
 * redirect to.
 */

import { Navigate, useNavigate, useParams } from 'react-router-dom';
import {
  Button,
  Skeleton,
  SkeletonItem,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ClipboardTaskListLtrRegular } from '@fluentui/react-icons';
import { EmptyState } from '../../shared/components/EmptyState';
import { ReviewAgainButton } from './components/ReviewAgainButton';
import { useReview, useReviewResults } from './hooks/use-reviews';

const useStyles = makeStyles({
  page: {
    padding: `${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalXXL}`,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    width: '100%',
    maxWidth: '1024px',
    marginLeft: 'auto',
    marginRight: 'auto',
  },
});

export default function ReviewRedirectPage() {
  const styles = useStyles();
  const navigate = useNavigate();
  const { reviewId = '' } = useParams();

  const review = useReview(reviewId);
  const results = useReviewResults(reviewId);

  if (review.isPending || results.isPending) {
    return (
      <main className={styles.page}>
        <Skeleton aria-label="Opening the review">
          <SkeletonItem size={32} />
          <div style={{ height: 16 }} />
          <SkeletonItem size={16} />
        </Skeleton>
      </main>
    );
  }

  if (review.isError || !review.data) {
    return (
      <main className={styles.page}>
        <EmptyState
          icon={ClipboardTaskListLtrRegular}
          title="We couldn't load this review"
          description="Something went wrong fetching the review. Try again in a moment."
          action={
            <Button appearance="primary" onClick={() => void review.refetch()}>
              Try again
            </Button>
          }
        />
      </main>
    );
  }

  // `listResults` orders by sequence number descending, so the first row is the newest snapshot.
  const newest = results.data?.[0];
  if (newest) {
    // Replaced, not pushed: this address is a resolution step, and leaving it in history would make
    // Back bounce the reader straight forward again.
    return <Navigate to={`/reviews/${reviewId}/results/${newest.id}`} replace />;
  }

  return (
    <main className={styles.page}>
      <EmptyState
        icon={ClipboardTaskListLtrRegular}
        title="No results yet"
        description="Run this review to produce its first result."
        action={
          <ReviewAgainButton
            review={review.data}
            onCreated={created => navigate(`/reviews/${reviewId}/results/${created.id}`)}
          />
        }
      />
    </main>
  );
}
