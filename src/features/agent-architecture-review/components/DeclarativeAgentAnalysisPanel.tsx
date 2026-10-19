/**
 * Results for a snapshot whose subject is an uploaded M365 declarative agent package.
 *
 * A third panel beside {@link AnalysisPanel}'s pillar layout and {@link SkillAnalysisPanel}, for the
 * same reason those two are separate: a declarative agent is graded on ART's own six-criterion DA
 * rubric — instructions, knowledge, capabilities, actions, conversation starters, error handling —
 * over a package of JSON manifests, not on the six agent pillars and not on the skill rubric.
 * Forcing it into either shape would mean inventing a pillar it was never measured against.
 *
 * Nothing here computes a score. `result.score` is the number ART wrote to `cat_overallscore`, and
 * the weights beside each criterion come from ART's own `buildDAScoreBreakdown`: the number on this
 * screen and the number in the Agent Review Tool are the same number, produced by the same
 * function. Re-deriving either would be reimplementing the rubric, which is exactly what this app
 * does not do.
 *
 * Two presentation rules are carried over from ART deliberately, because breaking either one turns
 * a missing measurement into a verdict:
 *
 *  1. A criterion that could not be assessed reads "Not assessed", never 0, and its weight is
 *     reported as excluded rather than quietly counted against the agent.
 *  2. The rule list is the shared {@link ConsolidatedFindingsList}, so a DA rule that passed looks
 *     like every other passing rule in this app and opens the same drawer. Dismissal is not offered
 *     — a DA review has nowhere to record one, and showing a control that forgets what the reviewer
 *     told it is worse than not showing it.
 */

import { useMemo } from 'react';
import {
  Card,
  CardHeader,
  Caption1,
  Subtitle2,
  Text,
  Title3,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ConsolidatedFindingsList } from '@review-ui';
import { ScoreSummary } from './ScoreSummary';
import { gradeForScore } from '../models/review';
import { buildDAFindingsView } from './daFindings';
import {
  buildDAScoreBreakdown,
  type DAEvaluationResult,
  type DAScoreBreakdownPart,
} from '../engine/scoring/art-ports';
import type { DeclarativeAgentReview } from '../models/art';

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
});

/**
 * One criterion of the DA rubric.
 *
 * `effectiveWeight` is already a percentage and is renormalised over the criteria that were
 * actually assessed, so the six cards on screen always add up to the score beside them even when a
 * criterion was withheld.
 */
function CriterionCard({ part }: { part: DAScoreBreakdownPart }) {
  const styles = useStyles();
  const assessed = part.score !== null;
  return (
    <Card className={styles.card}>
      <CardHeader
        header={
          <span className={styles.cardHead}>
            <Subtitle2>{part.label}</Subtitle2>
            {assessed ? (
              <Title3>{Math.round(part.score ?? 0)}%</Title3>
            ) : (
              <Text weight="semibold" className={styles.muted}>
                Not assessed
              </Text>
            )}
          </span>
        }
      />
      <Caption1 className={styles.muted}>
        {assessed
          ? `Carries ${Math.round(part.effectiveWeight)}% of the score`
          : 'Excluded from the score'}
      </Caption1>
    </Card>
  );
}

export function DeclarativeAgentAnalysisPanel({
  result,
  agentName,
  header,
}: {
  result: DeclarativeAgentReview;
  agentName: string;
  header?: React.ReactNode;
}) {
  const styles = useStyles();

  // An absent evaluation is still six criteria nobody measured, so it is reported as six withheld
  // cards rather than an empty rail. ART's builder returns nothing at all for `undefined`, so the
  // empty object is what makes it name the criteria it knows about.
  const parts = useMemo(
    () => buildDAScoreBreakdown(result.data.evaluation ?? ({} as DAEvaluationResult)),
    [result.data.evaluation],
  );
  const da = useMemo(() => buildDAFindingsView(result.data), [result.data]);

  return (
    <div className={styles.root}>
      <div className={styles.scoreRow}>
        <ScoreSummary
          score={result.score}
          grade={result.score === null ? null : gradeForScore(result.score)}
          caption={`Declarative agent · ${agentName}`}
          subCaption="Scored against the declarative agent rubric, not the six agent pillars"
        />
      </div>

      {header}

      <div className={styles.cards}>
        {parts.map(part => (
          <CriterionCard key={part.key} part={part} />
        ))}
      </div>

      <ConsolidatedFindingsList
        view={da.view}
        ruleMeta={da.ruleMeta}
        referenceUrl={da.referenceUrl}
        emptyMessage="This review was recorded before per-rule results were saved, so only its score is available. Run it again to see the full list of checks."
      />
    </div>
  );
}
