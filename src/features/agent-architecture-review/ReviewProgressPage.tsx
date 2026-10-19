/**
 * Progress tracker — `/reviews/:reviewId/progress`.
 *
 * A review accumulates snapshots that deliberately disagree, and until now the only way to read that
 * disagreement was one snapshot at a time. This page puts the whole series in one line: how the score
 * of each reviewed agent has moved from the first reading to the latest, with the snapshots that
 * produced those readings listed underneath.
 *
 * One agent at a time, chosen by the buttons above the chart, because a review of a parent agent and
 * its connected agents is a review of several different things that happen to share a run — stacking
 * them on one axis invites a comparison between agents that nothing in the rubric supports.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Skeleton,
  SkeletonItem,
  Subtitle2,
  Text,
  Title2,
  Title3,
  ToggleButton,
  Tooltip,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowLeftRegular,
  ArrowTrendingDownRegular,
  ArrowTrendingRegular,
  ClipboardTaskListLtrRegular,
} from '@fluentui/react-icons';
import { LineChart } from '@fluentui/react-charting';
import { EmptyState } from '../../shared/components/EmptyState';
import { ReviewAgainButton } from './components/ReviewAgainButton';
import { SnapshotTimeline } from './components/SnapshotTimeline';
import { useReview } from './hooks/use-reviews';
import { useReviewProgress } from './hooks/use-review-progress';
import { summarize, scoreAxisRange, type AgentSeries } from './services/review-progress';

/**
 * Chart colours are raw hex, never `tokens.*`.
 *
 * `@fluentui/react-charting` paints straight onto SVG attributes and does not resolve CSS variables,
 * so a token would arrive as the literal string `var(--colorBrandForeground1)` and draw nothing.
 */
const LINE_COLORS = {
  up: '#107c10',
  down: '#c50f1f',
  flat: '#0f6cbd',
};

const CHART_HEIGHT = 260;

/** Narrower than this and the margins alone consume the plot area, so the chart is left out. */
const MIN_CHART_WIDTH = 220;

/**
 * Axis room: the x-axis title needs 55px below and the y-axis title 40px to the left, per the
 * component's own documented minimums.
 */
const CHART_MARGINS = { top: 16, bottom: 55, left: 50, right: 24 };

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
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalL,
  },
  titleRow: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
  subtitle: { color: tokens.colorNeutralForeground2 },
  agents: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalS,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalM,
    padding: tokens.spacingVerticalL,
    borderRadius: tokens.borderRadiusLarge,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  headline: { display: 'flex', alignItems: 'baseline', gap: tokens.spacingHorizontalS },
  // The chart is measured rather than given a fixed width: LineChart takes a number, and a number
  // guessed here would either overflow a narrow window or waste a wide one.
  chart: { width: '100%', minHeight: `${CHART_HEIGHT}px` },
  sectionHeading: { marginTop: tokens.spacingVerticalM },
});

/** The rendered width of an element, so the chart can be sized to the space it actually has. */
function useMeasuredWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => {
      const measured = entries[0]?.contentRect.width ?? 0;
      setWidth(Math.floor(measured));
    });
    observer.observe(element);
    setWidth(Math.floor(element.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

function ScoreChart({ series }: { series: AgentSeries }) {
  const styles = useStyles();
  const { ref, width } = useMeasuredWidth();
  const summary = summarize(series);

  const direction = !summary || summary.delta === 0 ? 'flat' : summary.delta > 0 ? 'up' : 'down';

  const data = useMemo(
    () => ({
      chartTitle: series.agentName,
      lineChartData: [
        {
          legend: series.agentName,
          color: LINE_COLORS[direction],
          data: series.points.map(point => ({
            x: point.sequenceNumber,
            y: point.score,
            xAxisCalloutData: `Results #${point.sequenceNumber}`,
            yAxisCalloutData: `${point.score}/100`,
          })),
        },
      ],
    }),
    [direction, series.agentName, series.points],
  );

  const band = useMemo(
    () => scoreAxisRange(series.points.map(point => point.score)),
    [series.points],
  );

  // Only the snapshots that actually produced a reading get a tick, so no label ever names a
  // snapshot this agent was not scored in.
  const ticks = useMemo(
    () => series.points.map(point => point.sequenceNumber),
    [series.points],
  );

  if (!summary) return null;

  return (
    <div className={styles.card}>
      <div>
        <div className={styles.headline}>
          <Title2>{summary.latest}</Title2>
          <Text className={styles.subtitle}>/ 100</Text>
          {summary.delta !== 0 ? (
            <Badge
              shape="rounded"
              appearance="outline"
              color={direction === 'up' ? 'success' : 'danger'}
              icon={direction === 'up' ? <ArrowTrendingRegular /> : <ArrowTrendingDownRegular />}
            >
              {summary.delta > 0 ? '+' : '−'}
              {Math.abs(summary.delta)} since Results #{summary.firstSequence}
            </Badge>
          ) : (
            <Badge shape="rounded" appearance="outline" color="informative">
              Unchanged since Results #{summary.firstSequence}
            </Badge>
          )}
        </div>
        <Caption1 className={styles.subtitle}>{series.agentName}</Caption1>
      </div>

      <div className={styles.chart} ref={ref}>
        {series.points.length < 2 ? (
          <Caption1 className={styles.subtitle}>
            One reading so far. Review this agent again to start a trend.
          </Caption1>
        ) : width >= MIN_CHART_WIDTH ? (
          <LineChart
            data={data}
            width={width}
            height={CHART_HEIGHT}
            margins={CHART_MARGINS}
            yMinValue={band.min}
            yMaxValue={band.max}
            tickValues={ticks}
            tickFormat="d"
            xAxisTitle="Results #"
            yAxisTitle="Score"
            hideLegend
            enablePerfOptimization={false}
          />
        ) : null}
      </div>
    </div>
  );
}

export default function ReviewProgressPage() {
  const styles = useStyles();
  const navigate = useNavigate();
  const location = useLocation();
  const { reviewId = '' } = useParams();

  const review = useReview(reviewId);
  const { results, progress, isPending, isError, refetch } = useReviewProgress(
    reviewId,
    review.data?.botName ?? review.data?.projectName ?? 'This review',
  );

  const [selectedAgentId, setSelectedAgentId] = useState<string>();

  /** The snapshot the reader came from, so Back returns them to it rather than to the newest. */
  const cameFrom = (location.state as { from?: string } | null)?.from;
  const backTarget = cameFrom ?? results[0]?.id;

  const goBack = useCallback(() => {
    navigate(backTarget ? `/reviews/${reviewId}/results/${backTarget}` : '/reviews');
  }, [backTarget, navigate, reviewId]);

  const series = progress.series;
  // The parent agent is what the review is about, so it is what the page opens on.
  const selected = series.find(item => item.agentId === selectedAgentId) ?? series[0];

  if (review.isPending || isPending) {
    return (
      <main className={styles.page}>
        <Skeleton aria-label="Loading progress">
          <SkeletonItem size={32} />
          <div style={{ height: 16 }} />
          <SkeletonItem size={16} />
        </Skeleton>
      </main>
    );
  }

  if (review.isError || !review.data || isError) {
    return (
      <main className={styles.page}>
        <EmptyState
          icon={ClipboardTaskListLtrRegular}
          title="We couldn't load this review's progress"
          description="Something went wrong fetching the snapshots. Try again in a moment."
          action={
            <Button appearance="primary" onClick={refetch}>
              Try again
            </Button>
          }
        />
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.titleRow}>
          <Button
            appearance="subtle"
            icon={<ArrowLeftRegular />}
            aria-label="Back to the results"
            onClick={goBack}
          />
          <Title3>{review.data.projectName}</Title3>
        </div>
        <ReviewAgainButton
          review={review.data}
          onCreated={created => navigate(`/reviews/${reviewId}/results/${created.id}`)}
        />
      </div>

      <Body1 className={styles.subtitle}>
        How this review&apos;s scores have moved across {results.length}{' '}
        {results.length === 1 ? 'reading' : 'readings'}.
      </Body1>

      {/*
        Said rather than silently shown: an uploaded skill can be re-reviewed against a different
        artifact, and a chart that quietly starts at the third snapshot owes the reader that reason.
      */}
      {progress.excludedForSubjectChange > 0 ? (
        <Caption1 className={styles.subtitle}>
          {progress.excludedForSubjectChange} earlier{' '}
          {progress.excludedForSubjectChange === 1 ? 'snapshot' : 'snapshots'} reviewed a different
          subject and {progress.excludedForSubjectChange === 1 ? 'is' : 'are'} not charted.
        </Caption1>
      ) : null}

      {/*
        Hidden for a lone agent: a single button that is always on is a control that does nothing.
      */}
      {series.length > 1 ? (
        <div className={styles.agents} role="group" aria-label="Agents in this review">
          {series.map(item => (
            <Tooltip
              key={item.agentId || item.agentName}
              relationship="description"
              content={item.isParent ? 'The agent this review is about' : 'Connected agent'}
            >
              <ToggleButton
                checked={item.agentId === selected?.agentId}
                onClick={() => setSelectedAgentId(item.agentId)}
              >
                {item.agentName}
              </ToggleButton>
            </Tooltip>
          ))}
        </div>
      ) : null}

      {selected ? (
        <ScoreChart series={selected} />
      ) : (
        <EmptyState
          icon={ArrowTrendingRegular}
          title="No scores to chart yet"
          description="Once a snapshot of this review produces a score, its progress appears here."
        />
      )}

      <Subtitle2 className={styles.sectionHeading}>
        Reviews ({results.length})
      </Subtitle2>
      <SnapshotTimeline
        results={results}
        currentResultId={cameFrom}
        onOpen={resultId => navigate(`/reviews/${reviewId}/results/${resultId}`)}
      />
    </main>
  );
}
