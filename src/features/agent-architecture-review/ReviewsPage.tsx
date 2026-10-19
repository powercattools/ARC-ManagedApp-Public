/**
 * Reviews landing page (Figma 8650:28881).
 *
 * Follows the CoreAI `FilterableList` template: a toolbar of search plus filter
 * dropdowns above a sortable, paginated DataGrid (FR-121).
 */

import { useMemo, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Body1,
  Button,
  Caption1,
  DataGrid,
  DataGridBody,
  DataGridCell,
  DataGridHeader,
  DataGridHeaderCell,
  DataGridRow,
  Dropdown,
  Link,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  Option,
  SearchBox,
  Skeleton,
  SkeletonItem,
  Text,
  Title3,
  createTableColumn,
  makeStyles,
  tokens,
  type TableColumnDefinition,
} from '@fluentui/react-components';
import {
  AddRegular,
  BotRegular,
  ClipboardTaskListLtrRegular,
  DocumentRegular,
  PuzzlePieceRegular,
  SearchRegular,
  SettingsRegular,
} from '@fluentui/react-icons';
import { EmptyState } from '../../shared/components/EmptyState';
import { PlaceholderIllustration } from '../../shared/components/PlaceholderIllustration';
import { GradeBadge } from './components/GradeBadge';
import { NewReviewDialog } from './components/NewReviewDialog';
import { useReviews } from './hooks/use-reviews';
import { ASSET_TYPE_LABELS, HARNESS_LABELS, type AssetType, type Review } from './models/review';

const PAGE_SIZE = 10;

/**
 * Which harness reviewed this agent.
 *
 * The harness is a property of the run, not of the project: the same asset type covers both the
 * Copilot and the Standard harness, and which one applies is decided by the agent's configuration at
 * capture time. So it is read from the newest snapshot's parent agent row, and only falls back to the
 * asset type when no snapshot has run yet — before that there is genuinely nothing to report. It used
 * to always show the asset type, which read "Copilot Studio Agent" for a classic agent the Standard
 * harness had reviewed.
 */
function harnessLabel(review: Review): string {
  return review.harness ? HARNESS_LABELS[review.harness] : ASSET_TYPE_LABELS[review.assetType];
}

const useStyles = makeStyles({
  page: {
    padding: `${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalXXL}`,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    // Figma centers the page content in a fixed 1024px column (frame 8647:22659).
    width: '100%',
    maxWidth: '1024px',
    marginLeft: 'auto',
    marginRight: 'auto',
  },
  headerRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalL,
  },
  heading: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  headerActions: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, flexShrink: 0 },
  subtitle: { color: tokens.colorNeutralForeground2 },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
  search: { minWidth: '260px' },
  filter: { minWidth: '160px' },
  count: { color: tokens.colorNeutralForeground2 },
  nameCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  gradeCell: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  nameButton: {
    justifyContent: 'flex-start',
    padding: 0,
    minWidth: 'unset',
    fontWeight: tokens.fontWeightSemibold,
  },
  skeletonRow: {
    display: 'grid',
    gridTemplateColumns: '2fr 1fr 1fr 1fr',
    gap: tokens.spacingHorizontalL,
    alignItems: 'center',
    padding: `${tokens.spacingVerticalM} 0`,
  },
  pager: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: tokens.spacingHorizontalM,
    paddingTop: tokens.spacingVerticalS,
  },
});

const ASSET_ICONS: Record<AssetType, ReactElement> = {
  'copilot-studio-agent': <BotRegular />,
  'declarative-agent': <DocumentRegular />,
  skill: <PuzzlePieceRegular />,
};

function formatDate(value: string | null): string {
  if (!value) return '-';
  return new Date(value).toLocaleDateString();
}

function LoadingRows() {
  const styles = useStyles();
  return (
    <Skeleton aria-label="Loading reviews">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className={styles.skeletonRow}>
          <SkeletonItem size={16} />
          <SkeletonItem size={16} />
          <SkeletonItem size={16} />
          <SkeletonItem size={16} />
        </div>
      ))}
    </Skeleton>
  );
}

export default function ReviewsPage() {
  const styles = useStyles();
  const navigate = useNavigate();

  const [search, setSearch] = useState('');
  const [assetType, setAssetType] = useState('all');
  const [status, setStatus] = useState('active');
  const [page, setPage] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);

  /**
   * Opens the newest snapshot of a review.
   *
   * A review is only ever read through one of its snapshots, so the grid goes straight to the
   * newest rather than by way of a list the reader would have to click through. A review that has
   * never run has no snapshot to open, and `/reviews/{id}` says so.
   */
  const openReview = useMemo(
    () => (review: Review) =>
      navigate(
        review.currentResultId
          ? `/reviews/${review.id}/results/${review.currentResultId}`
          : `/reviews/${review.id}`,
      ),
    [navigate],
  );

  const filters = useMemo(
    () => ({ search, assetType, status }),
    [search, assetType, status],
  );
  const { data, isPending, isError, refetch } = useReviews(filters);

  const reviews = useMemo(() => data ?? [], [data]);
  const pageCount = Math.max(1, Math.ceil(reviews.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const pageRows = useMemo(
    () => reviews.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    [reviews, safePage],
  );

  const hasFilters = search.trim().length > 0 || assetType !== 'all' || status !== 'active';

  const columns: TableColumnDefinition<Review>[] = useMemo(
    () => [
      createTableColumn<Review>({
        columnId: 'name',
        compare: (a, b) => a.projectName.localeCompare(b.projectName),
        renderHeaderCell: () => 'Name',
        renderCell: (review) => (
          <div className={styles.nameCell}>
            {ASSET_ICONS[review.assetType]}
            <Button
              appearance="transparent"
              className={styles.nameButton}
              onClick={() => openReview(review)}
            >
              {review.projectName}
            </Button>
          </div>
        ),
      }),
      createTableColumn<Review>({
        columnId: 'harness',
        compare: (a, b) => harnessLabel(a).localeCompare(harnessLabel(b)),
        renderHeaderCell: () => 'Harness',
        renderCell: (review) => <Text>{harnessLabel(review)}</Text>,
      }),
      createTableColumn<Review>({
        columnId: 'grade',
        compare: (a, b) => (a.currentScore ?? 0) - (b.currentScore ?? 0),
        renderHeaderCell: () => 'Grade',
        renderCell: (review) => (
          <div className={styles.gradeCell}>
            <GradeBadge grade={review.currentGrade} />
            <Text>{review.currentScore == null ? '-' : `${review.currentScore}%`}</Text>
          </div>
        ),
      }),
      createTableColumn<Review>({
        columnId: 'lastRun',
        compare: (a, b) => (a.lastRun ?? '').localeCompare(b.lastRun ?? ''),
        renderHeaderCell: () => 'Last run',
        renderCell: (review) => <Text>{formatDate(review.lastRun)}</Text>,
      }),
    ],
    [openReview, styles],
  );

  return (
    <main className={styles.page}>
      <div className={styles.headerRow}>
        <div className={styles.heading}>
          <Title3>Agent Review Center</Title3>
          <Body1 className={styles.subtitle}>
            Review your agents against consistent architecture criteria and track how their
            scores change over time. <Link href="#">Learn more</Link>
          </Body1>
        </div>
        {/*
          Settings sits beside the primary action rather than in a shell banner: the banner was the
          only thing that chrome carried, and one gear next to the one button that creates work is
          where a reader already is when they need it.
        */}
        <div className={styles.headerActions}>
          <Button appearance="primary" icon={<AddRegular />} onClick={() => setDialogOpen(true)}>
            Add review
          </Button>
          <Button
            appearance="subtle"
            icon={<SettingsRegular />}
            aria-label="Settings"
            title="Settings"
            onClick={() => navigate('/setup')}
          />
        </div>
      </div>

      <div className={styles.toolbar}>
        <SearchBox
          className={styles.search}
          placeholder="Search"
          value={search}
          onChange={(_, data) => {
            setSearch(data.value);
            setPage(0);
          }}
        />
        <Dropdown
          className={styles.filter}
          value={assetType === 'all' ? 'All types' : ASSET_TYPE_LABELS[assetType as AssetType]}
          selectedOptions={[assetType]}
          onOptionSelect={(_, data) => {
            setAssetType(data.optionValue ?? 'all');
            setPage(0);
          }}
        >
          <Option value="all" text="All types">
            All types
          </Option>
          {(Object.keys(ASSET_TYPE_LABELS) as AssetType[]).map((type) => (
            <Option key={type} value={type} text={ASSET_TYPE_LABELS[type]}>
              {ASSET_TYPE_LABELS[type]}
            </Option>
          ))}
        </Dropdown>
        <Dropdown
          className={styles.filter}
          value={status === 'all' ? 'All statuses' : status === 'active' ? 'Active' : 'Inactive'}
          selectedOptions={[status]}
          onOptionSelect={(_, data) => {
            setStatus(data.optionValue ?? 'active');
            setPage(0);
          }}
        >
          <Option value="active" text="Active">
            Active
          </Option>
          <Option value="inactive" text="Inactive">
            Inactive
          </Option>
          <Option value="all" text="All statuses">
            All statuses
          </Option>
        </Dropdown>
      </div>

      {isError ? (
        <MessageBar intent="error">
          <MessageBarBody>We couldn&apos;t load your reviews.</MessageBarBody>
          <MessageBarActions>
            <Button size="small" onClick={() => void refetch()}>
              Try again
            </Button>
          </MessageBarActions>
        </MessageBar>
      ) : null}

      {isPending ? (
        <LoadingRows />
      ) : reviews.length === 0 ? (
        hasFilters ? (
          <EmptyState
            icon={SearchRegular}
            title="No results found"
            description="Try adjusting your search or filters to find what you're looking for."
          />
        ) : (
          <EmptyState
            icon={ClipboardTaskListLtrRegular}
            illustration={<PlaceholderIllustration />}
            title="No reviews yet"
            description="Reviews you create will appear here, along with their grade and history."
            action={
              <Button appearance="primary" icon={<AddRegular />} onClick={() => setDialogOpen(true)}>
                Add review
              </Button>
            }
          />
        )
      ) : (
        <>
          <Caption1 className={styles.count}>
            {reviews.length} review{reviews.length === 1 ? '' : 's'}
          </Caption1>

          <DataGrid items={pageRows} columns={columns} sortable getRowId={(review) => review.id}>
            <DataGridHeader>
              <DataGridRow>
                {({ renderHeaderCell }) => (
                  <DataGridHeaderCell>{renderHeaderCell()}</DataGridHeaderCell>
                )}
              </DataGridRow>
            </DataGridHeader>
            <DataGridBody<Review>>
              {({ item, rowId }) => (
                <DataGridRow<Review> key={rowId}>
                  {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
                </DataGridRow>
              )}
            </DataGridBody>
          </DataGrid>

          {pageCount > 1 ? (
            <div className={styles.pager}>
              <Button
                size="small"
                disabled={safePage === 0}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
              >
                Previous
              </Button>
              <Caption1>
                Page {safePage + 1} of {pageCount}
              </Caption1>
              <Button
                size="small"
                disabled={safePage >= pageCount - 1}
                onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
              >
                Next
              </Button>
            </div>
          ) : null}
        </>
      )}

      <NewReviewDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        /*
          Straight to the result the run just produced. The reader asked for a review and the review
          exists; making them pick it out of a list first was a step that only ever had one answer.

          What is still outstanding travels with them: an agent snapshot leaves transcript analysis
          running server-side, while an uploaded artifact has no conversations of its own to analyse,
          so the result page says so once on arrival rather than promising work that will never happen.
        */
        onCreated={(created, createdAssetType) =>
          navigate(`/reviews/${created.review.id}/results/${created.result.id}`, {
            state: { justCreated: createdAssetType },
          })
        }
      />
    </main>
  );
}
