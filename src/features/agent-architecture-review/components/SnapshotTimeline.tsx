/**
 * The snapshot timeline of one review (Figma `8650:37500`).
 *
 * A review is a sequence of readings that deliberately disagree, and the timeline is where that
 * disagreement is legible: each entry carries its own grade, its own score and the trend against the
 * reading before it. Lifted out of the retired review detail page so the progress page can show the
 * same list under its chart rather than growing a second, subtly different one.
 */

import {
  Badge,
  Caption1,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowTrendingDownRegular,
  ArrowTrendingRegular,
  WarningRegular,
} from '@fluentui/react-icons';
import { GradeBadge } from './GradeBadge';
import { deriveTrend, subjectChanged, type ReviewResult } from '../models/review';

const useStyles = makeStyles({
  timeline: { display: 'flex', flexDirection: 'column' },
  entry: { display: 'flex', gap: tokens.spacingHorizontalL },
  rail: { display: 'flex', flexDirection: 'column', alignItems: 'center' },
  connector: {
    flexGrow: 1,
    width: '2px',
    minHeight: '32px',
    backgroundColor: tokens.colorNeutralStroke2,
  },
  entryBody: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: tokens.spacingVerticalXXS,
    paddingBottom: tokens.spacingVerticalXXL,
    paddingTop: tokens.spacingVerticalXS,
    paddingLeft: tokens.spacingHorizontalS,
    paddingRight: tokens.spacingHorizontalS,
    flexGrow: 1,
    textAlign: 'left',
    backgroundColor: 'transparent',
    border: 'none',
    borderRadius: tokens.borderRadiusMedium,
    cursor: 'pointer',
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  entryHeading: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  muted: { color: tokens.colorNeutralForeground2 },
  trend: {
    display: 'flex',
    alignItems: 'center',
    marginTop: tokens.spacingVerticalXS,
  },
  artifact: { marginTop: tokens.spacingVerticalXS },
  /** The entry the reader arrived from, so the list says where they already are. */
  current: { backgroundColor: tokens.colorNeutralBackground1Selected },
});

function formatRunTimestamp(value: string): string {
  return new Date(value).toLocaleString();
}

function TimelineEntry({
  result,
  previous,
  isLast,
  isCurrent,
  onOpen,
}: {
  result: ReviewResult;
  previous: ReviewResult | undefined;
  isLast: boolean;
  isCurrent: boolean;
  onOpen: () => void;
}) {
  const styles = useStyles();
  const trend = deriveTrend(result, previous);

  return (
    <div className={styles.entry}>
      <div className={styles.rail}>
        <GradeBadge grade={result.grade} size="large" />
        {!isLast ? <div className={styles.connector} /> : null}
      </div>
      {/*
        A real button, not a div with a click handler: the whole row is the affordance for opening a
        snapshot, and keyboard and screen-reader users need it to behave like one.
      */}
      <button
        type="button"
        className={isCurrent ? `${styles.entryBody} ${styles.current}` : styles.entryBody}
        aria-current={isCurrent ? 'true' : undefined}
        onClick={onOpen}
      >
        <div className={styles.entryHeading}>
          <Text weight="semibold">
            Results #{result.sequenceNumber} &middot; Score {result.score ?? 'unavailable'}
          </Text>
          {result.status === 'active' ? (
            <Badge shape="rounded" appearance="tint" color="brand">
              Current
            </Badge>
          ) : null}
        </div>
        <Caption1 className={styles.muted}>{formatRunTimestamp(result.runTimestamp)}</Caption1>
        {result.artifactFileName ? (
          <Caption1 className={styles.artifact}>
            Artifact: {result.artifactFileName} (version {result.artifactVersion})
          </Caption1>
        ) : null}
        {trend && trend.direction !== 'flat' ? (
          <div className={styles.trend}>
            <Badge
              shape="rounded"
              appearance="outline"
              color={trend.direction === 'up' ? 'success' : 'danger'}
              icon={
                trend.direction === 'up' ? <ArrowTrendingRegular /> : <ArrowTrendingDownRegular />
              }
            >
              {trend.direction === 'up' ? 'Increased' : 'Decreased'} {trend.percentage}%
            </Badge>
          </div>
        ) : null}
        {/*
          Said where the trend would have been, because that is where the reader looks for it and
          its absence is the thing being explained. The snapshot is still a valid review — only the
          comparison is withheld.
        */}
        {subjectChanged(result, previous) ? (
          <div className={styles.trend}>
            <Badge shape="rounded" appearance="outline" color="warning" icon={<WarningRegular />}>
              Reviewed a different skill, so it is not comparable to the previous snapshot
            </Badge>
          </div>
        ) : null}
      </button>
    </div>
  );
}

export interface SnapshotTimelineProps {
  /** Newest first, as `listResults` returns them. */
  results: readonly ReviewResult[];
  /** The snapshot the reader came from, highlighted so the list places them in it. */
  currentResultId?: string;
  onOpen: (resultId: string) => void;
}

export function SnapshotTimeline({ results, currentResultId, onOpen }: SnapshotTimelineProps) {
  const styles = useStyles();

  return (
    <div className={styles.timeline}>
      {results.map((result, index) => (
        <TimelineEntry
          key={result.id}
          result={result}
          previous={results[index + 1]}
          isLast={index === results.length - 1}
          isCurrent={result.id === currentResultId}
          onOpen={() => onOpen(result.id)}
        />
      ))}
    </div>
  );
}
