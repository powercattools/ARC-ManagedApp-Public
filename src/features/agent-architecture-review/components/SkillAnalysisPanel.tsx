/**
 * Results for a snapshot whose subject is an uploaded skill or automation.
 *
 * A skill review and an agent review are both ART reviews, but they are not the same record. An
 * agent review has pillars, components and an instruction inventory; a skill review has six
 * weighted rubric dimensions and the file list it was read from. Forcing one into the other's
 * shape is what would lose information, so this panel renders the artifact shape directly and
 * {@link AnalysisPanel} chooses between them.
 *
 * Nothing here computes a score. `overallScoreOf` and `effectiveWeights` are ART's, imported
 * through the port: the number on this screen and the number in the Agent Review Tool's own report
 * are the same number, produced by the same function.
 *
 * One presentation rule is carried over from ART's panel deliberately, because breaking it turns a
 * missing measurement into a verdict: a dimension that could not be assessed reads "Not assessed",
 * never 0.
 */

import { useMemo, useState } from 'react';
import {
  Caption1,
  Caption1Strong,
  Card,
  CardHeader,
  MessageBar,
  MessageBarBody,
  Subtitle2,
  Tab,
  TabList,
  Text,
  Title3,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { DocumentRegular } from '@fluentui/react-icons';
import { EmptyState } from '../../../shared/components/EmptyState';
import { ScoreSummary } from './ScoreSummary';
import { gradeForScore } from '../models/review';
import { ConsolidatedFindingsList } from '@review-ui';
import { buildArtifactFindingsView } from './artifactFindings';
import { ruleMetaLookup } from './ruleMetaLookup';
import {
  RECOMMENDATION_LABELS,
  RUBRIC_DIMENSION_DESCRIPTIONS,
  RUBRIC_DIMENSION_IMPROVEMENTS,
  RUBRIC_DIMENSION_LABELS,
  effectiveWeights,
  hasScore,
  overallScoreOf,
  type ArtifactReviewResult,
  type RubricDimensionScore,
} from '../engine/scoring/art-ports';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  scoreRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXL,
    flexWrap: 'wrap',
  },
  cards: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  card: { padding: tokens.spacingVerticalM, gap: tokens.spacingVerticalXS },
  cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS },
  muted: { color: tokens.colorNeutralForeground3 },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  fileRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalXS} 0`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  path: { fontFamily: tokens.fontFamilyMonospace, wordBreak: 'break-all' },
});

/** Dimension scores are recorded out of 5; everything on screen is a percentage. */
const MAX_DIMENSION_SCORE = 5;

/**
 * Skill severities badge on their own five-level scale.
 *
 * `severityAppearance` in the shared UI maps the agent scale (`error`/`warning`) and the runtime
 * scale (`High`/`Medium`); it reads every skill severity as informational, which would show a
 * critical safety finding in the same grey as a note. Rather than widen a shared function that two
 * other screens depend on, the skill scale is mapped here, where it is the only scale in use.
 */
const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

function DimensionCard({ dimension, weight }: { dimension: RubricDimensionScore; weight?: number }) {
  const styles = useStyles();
  const assessed = typeof dimension.score === 'number' && Number.isFinite(dimension.score);
  const percent = assessed
    ? Math.round((Math.max(0, Math.min(MAX_DIMENSION_SCORE, dimension.score ?? 0)) / MAX_DIMENSION_SCORE) * 100)
    : null;

  return (
    <Card className={styles.card}>
      <CardHeader
        header={
          <span className={styles.cardHead}>
            <Subtitle2>{RUBRIC_DIMENSION_LABELS[dimension.id]}</Subtitle2>
            {percent === null ? (
              <Text weight="semibold" className={styles.muted}>
                Not assessed
              </Text>
            ) : (
              <Title3>{percent}%</Title3>
            )}
          </span>
        }
      />
      <Caption1 className={styles.muted}>{RUBRIC_DIMENSION_DESCRIPTIONS[dimension.id]}</Caption1>
      <Caption1 className={styles.muted}>
        {typeof weight === 'number' ? `Carries ${Math.round(weight)}% of the score` : 'Excluded from the score'}
      </Caption1>
      {percent !== null && percent < 100 ? (
        <>
          <Caption1Strong>How to improve</Caption1Strong>
          <Caption1>{dimension.improvement ?? RUBRIC_DIMENSION_IMPROVEMENTS[dimension.id]}</Caption1>
        </>
      ) : null}
    </Card>
  );
}

export interface SkillAnalysisPanelProps {
  result: ArtifactReviewResult;
  /** Rendered above the tabs, so the snapshot's agent picker stays where it is on every harness. */
  header?: React.ReactNode;
}

export function SkillAnalysisPanel({ result, header }: SkillAnalysisPanelProps) {
  const styles = useStyles();
  const [tab, setTab] = useState('dimensions');

  const weights = useMemo(() => effectiveWeights(result), [result]);
  const scored = hasScore(result);
  const score = overallScoreOf(result);

  const findings = useMemo(
    () =>
      [...(result.findings ?? [])].sort(
        (a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9),
      ),
    [result.findings],
  );

  /**
   * Every rule that was applied to this bundle, not only the ones that objected.
   *
   * Built here rather than in the adapter's caller so the list and the tab count cannot disagree:
   * the tab still counts findings, because a reader scanning the tabs is asking how much went
   * wrong, while the panel below answers what was checked.
   */
  const consolidated = useMemo(() => buildArtifactFindingsView(result), [result]);

  const files = result.files ?? [];

  return (
    <div className={styles.root}>
      <div className={styles.scoreRow}>
        <ScoreSummary
          score={scored ? score : null}
          grade={scored ? gradeForScore(score) : null}
          caption={`${result.artifactKind === 'automation' ? 'Automation' : 'Skill'} · ${result.artifactName}`}
          subCaption={`Reviewed ${result.reviewedAt ? new Date(result.reviewedAt).toLocaleString() : 'recently'}${
            result.recommendation ? ` · ${RECOMMENDATION_LABELS[result.recommendation]}` : ''
          }`}
        />
      </div>

      {header}

      {result.aiAvailable === false ? (
        <MessageBar intent="warning">
          <MessageBarBody>
            The AI stage did not run for this review, so the dimensions it owns were not assessed and
            their weight was spread across the rest. The score below is a partial one.
          </MessageBarBody>
        </MessageBar>
      ) : null}

      {result.error ? (
        <MessageBar intent="error">
          <MessageBarBody>{result.error}</MessageBarBody>
        </MessageBar>
      ) : null}

      <TabList selectedValue={tab} onTabSelect={(_, data) => setTab(data.value as string)}>
        <Tab value="dimensions">Rubric ({result.dimensions?.length ?? 0})</Tab>
        <Tab value="findings">Findings ({findings.length})</Tab>
        <Tab value="files">Files ({files.length})</Tab>
      </TabList>

      {tab === 'dimensions' ? (
        (result.dimensions?.length ?? 0) === 0 ? (
          <EmptyState
            icon={DocumentRegular}
            title="No rubric dimensions were recorded"
            description="This review was stored before the current result format. Run it again to see the rubric."
          />
        ) : (
          <div className={styles.cards}>
            {result.dimensions.map((dimension) => (
              <DimensionCard key={dimension.id} dimension={dimension} weight={weights.get(dimension.id)} />
            ))}
          </div>
        )
      ) : null}

      {tab === 'findings' ? (
        <ConsolidatedFindingsList
          view={consolidated}
          ruleMeta={ruleMetaLookup}
          emptyMessage="This review was saved before per-rule results were recorded. Run the review again to see the full list."
        />
      ) : null}

      {tab === 'files' ? (
        files.length === 0 ? (
          <EmptyState
            icon={DocumentRegular}
            title="File list unavailable"
            description="This review was stored before the file list was kept. It does not mean the bundle was empty."
          />
        ) : (
          <div className={styles.list}>
            {files.map((file) => (
              <div key={file.path} className={styles.fileRow}>
                <Caption1 className={styles.path}>{file.path}</Caption1>
                <Caption1 className={styles.muted}>
                  {file.omitted ? `not read · ${file.omitted}` : `${file.bytes} bytes`}
                </Caption1>
              </div>
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}
