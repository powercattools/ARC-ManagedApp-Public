/**
 * Analysis panel — the results screen from Figma frame 8673:12290.
 *
 * Layout: rolled-up score, then the run's facts — including one row per weighted pillar — then
 * tabs over the detail. Everything shown is read from the Agent Review Tool; this app scores
 * nothing itself.
 *
 * The score's letter comes from `gradeForScore`, derived from the number beside it rather than
 * stored, so the two can never disagree.
 *
 * When the reviewed agent has connected agents, each is a selectable target.
 * ART grades a connected agent only as a *pattern of its parent* — it records
 * the child's name and description and never opens the child's own components —
 * so a real per-child score has to come from that child's own ART review. The
 * rolled-up number is therefore a mean across the agents that have one.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  Button,
  Link,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Skeleton,
  SkeletonItem,
  Tab,
  TabList,
  ToggleButton,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  AgentsFilled,
  AgentsRegular,
  PuzzlePieceRegular,
} from '@fluentui/react-icons';
import { EmptyState } from '../../../shared/components/EmptyState';
import { ScoreSummary } from './ScoreSummary';
import { ComponentInventory } from './ComponentInventory';
import {
  ConsolidatedFindingsList,
  buildConsolidatedView,
  type ConsolidatedRow,
  type ReviewSummaryMetadata,
  type StageStatusInput,
} from '@review-ui';
import { AgentMapTab, buildReviewViewModel, describeWorkflowOutcome, formatDuration, prettyModelSeries, rescoreGroundedScore, rescorePillars, type PillarBreakdown, type RescoreInput, type SkillView } from '../engine/scoring/art-ports';
import { SkillFindingTabs } from './SkillFindingTabs';
import { ruleMetaLookup } from './ruleMetaLookup';
import { useConnectedAgentMap } from '../hooks/use-connected-agent-map';
import { useDismissals } from '../hooks/use-dismissals';
import { RuntimePanel } from './RuntimePanel';
import { SkillAnalysisPanel } from './SkillAnalysisPanel';
import { DeclarativeAgentAnalysisPanel } from './DeclarativeAgentAnalysisPanel';
import { artService } from '../services/art-service';
import { crossSkillRows } from '../services/cross-skill-rows';
import { isOrchestrated } from '../services/snapshot-orchestration';
import { useAggregatedReview, useArtLinkContext } from '../hooks/use-art';
import { gradeForScore, type Review, type ReviewResult } from '../models/review';
import { aggregateScore, scoredPillars, type ArtReview } from '../models/art';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  scoreRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXXL,
    flexWrap: 'wrap',
  },
  agentRow: { display: 'flex', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
});

export interface AnalysisPanelProps {
  review: Review;
  /** The snapshot being viewed. Runtime evidence belongs to it, not to the review. */
  result?: ReviewResult;
}

/**
 * What the scorer needs to grade one review under a given set of decisions.
 *
 * Shared by the rescore shown on screen and the one written back to the snapshot, so the number the
 * reviewer reads and the numbers the review list and the shared report read cannot come from two
 * implementations of the same weighting. ART does the arithmetic; this only assembles its input.
 */
function rescoreInputFor(review: ArtReview, dismissed: ReadonlySet<string>): RescoreInput {
  // Legacy blend rows are dropped rather than mapped: ART scores the six pillars, so a
  // pre-refactor row naming the old 'Patterns' half has no weight to be rescored against.
  const pillars: PillarBreakdown[] = scoredPillars(review.pillars).map(p => ({
    pillar: p.name,
    weight: p.weight,
    applicable: p.applicable,
    score: p.applicable ? p.score : null,
    complete: p.complete,
  }));

  return {
    pillars,
    ruleResults: review.ruleResults,
    coverage: {
      covered: review.coverage.filter(c => c.cases > 0).length,
      total: review.coverage.length,
      basis: review.coverageBasis,
      uncoveredIds: review.coverage.filter(c => c.cases === 0).map(c => c.name),
    },
    dismissed,
  };
}

export function AnalysisPanel({ review, result }: AnalysisPanelProps) {
  const styles = useStyles();
  const [selectedBot, setSelectedBot] = useState<string | undefined>(review.botId);
  const [tab, setTab] = useState('findings');

  const orchestrated = isOrchestrated(result);
  const analysis = useAggregatedReview(review.botId, review.environmentUrl, result);
  const linkContext = useArtLinkContext();

  const agents = useMemo(() => analysis.data?.agents ?? [], [analysis.data]);

  const selected = useMemo(() => {
    const match = agents.find((agent) => agent.botId === selectedBot);
    return match ?? agents[0];
  }, [agents, selectedBot]);

  const current = selected?.review;

  /**
   * What the review workflow actually returned for the agent on screen.
   *
   * A rule the workflow never answered for is saved as not-assessed, and the findings list shows
   * that as "Not assessed" — which is also what it shows for a rule that genuinely had nothing to
   * judge. The two are indistinguishable once they are in the list, so a review taken in an
   * environment where the flow was never turned on reads as an agent that simply had very little to
   * assess. This says which one happened, in the same words the Agent Review Tool uses.
   */
  const workflowOutcome = useMemo(
    () =>
      current?.workflowProvenance ? describeWorkflowOutcome(current.workflowProvenance) : undefined,
    [current?.workflowProvenance],
  );

  /**
   * What the decisions on screen are worth, for the copies of the score this app keeps.
   *
   * Passed into the dismissal hook rather than computed inside it, so recording a decision still
   * involves no knowledge of weighting. The rollup revises this agent's contribution to the mean
   * exactly as the header does — an override is a decision about one agent, not about the review.
   *
   * With nothing set aside the rubric's own number goes back rather than a recomputation of it. The
   * two agree, but writing the stored one means a reviewer who undoes every decision is left with
   * precisely the score the review was saved with, not one that merely rounds to it.
   */
  const reviseScores = useCallback(
    (keys: ReadonlySet<string>) => {
      if (!current || !selected) return undefined;

      const agent = keys.size === 0
        ? current.score
        : rescoreGroundedScore(rescoreInputFor(current, keys));

      const rollup = aggregateScore(agents.map(entry => (
        entry.botId === selected.botId && entry.review && agent !== null
          ? { ...entry, review: { ...entry.review, score: agent } }
          : entry
      )));

      return { agent, rollup };
    },
    [agents, current, selected],
  );

  /**
   * Rules this reviewer set aside for the agent on screen.
   *
   * Held against the snapshot rather than the agent, so reopening an older snapshot shows the score
   * its reader actually saw rather than one revised by decisions made afterwards.
   */
  const dismissal = useDismissals(result?.id, selected?.botId, reviseScores);

  /**
   * The score with those decisions applied.
   *
   * Recomputed here rather than read back, so the number moves the moment the button is pressed
   * instead of after a round trip. The same arithmetic over the same input is written to the
   * snapshot as it is applied, which is what keeps this panel, the review list and a shared report
   * reporting one score for one agent.
   */
  const rescored = useMemo(() => {
    if (!current || dismissal.keys.size === 0) return undefined;

    // The breakdown and the composite come from one input, so the rail below is the arithmetic the
    // headline was computed from. Deriving them separately is how a page ends up showing a score
    // its own pillars cannot reproduce.
    const input = rescoreInputFor(current, dismissal.keys);
    return { pillars: rescorePillars(input), score: rescoreGroundedScore(input) };
  }, [current, dismissal.keys]);

  const overriddenScore = rescored?.score;

  /**
   * The one list the Agent review tab shows.
   *
   * Built from rule outcomes rather than findings so a rule that passed in silence still appears.
   * `instructionCoverage` carries how far the non-deterministic stage got, which becomes the single
   * "could not run" row rather than leaving the reader to infer it from an absence.
   *
   * Cross-skill orchestration is merged in here rather than given a section of its own. ART returns
   * it on a separate field because no single skill owns it, and that is exactly why it has to be
   * joined back on: a rule with no outcome row contributes nothing to this list, so without it
   * those verdicts reached the PDF and never the screen.
   */
  const consolidated = useMemo(
    () => {
      // Guarded on the review's own outcomes so a pre-outcomes review still falls through to the
      // "saved before per-rule results were recorded" notice instead of being reported as recorded
      // on the strength of cross-skill rows alone.
      const recorded = current?.ruleResults?.length ? current.ruleResults : undefined;
      const crossSkill = crossSkillRows(recorded ? current?.orchestration : undefined);

      return buildConsolidatedView(
        recorded ? [...recorded, ...crossSkill.ruleResults] : undefined,
        [...(current?.findings ?? []), ...crossSkill.findings],
        current?.instructionCoverage
          ? { state: current.instructionCoverage.state as StageStatusInput['state'] }
          : undefined,
        undefined,
        dismissal.keys,
      );
    },
    [current, dismissal.keys],
  );

  /**
   * The same findings, in the shape the shared agent map reads.
   *
   * Only the three fields it uses — the map attributes findings to nodes by `componentIdUnique`,
   * which every rule stamps at the point it raises the finding.
   */
  const mapFindings = useMemo(
    () => (current?.findings ?? []).map(finding => ({
      sev: finding.severity,
      title: finding.title,
      componentIdUnique: finding.componentIdUnique,
    })),
    [current],
  );

  /**
   * ART's per-skill rubric for this review, built once.
   *
   * `reviewedBy` and the duration feed parts of the model the tabs never read — they use only
   * `skills` — so they are passed empty rather than invented.
   */
  const skillViews = useMemo<readonly SkillView[]>(
    () => (current?.displayPayload
      ? buildReviewViewModel(current.displayPayload, '', 0, selected?.botName ?? 'Agent').skills
      : []),
    [current, selected?.botName],
  );

  /**
   * The skill body a finding's drawer carries below its argument.
   *
   * Built as a callback rather than a node so only the opened row pays for it, and returned
   * `undefined` when the review has no skills at all so the drawer renders exactly as before.
   */
  const componentPanel = useMemo(
    () => (skillViews.length
      ? (row: ConsolidatedRow) => (
          <SkillFindingTabs row={row} skills={skillViews} view={consolidated} />
        )
      : undefined),
    [skillViews, consolidated],
  );

  /**
   * The run's facts, in the order Figma `9183:51209` fills them: two rows deep, then the next
   * column. So the sequence below reads Completed on / Duration, Model / Ignored, Memory / Web
   * search down each column rather than across.
   *
   * Model, memory and web search are the agent's own configuration as ART captured it at review
   * time, and only the Copilot harness records them — a standard or skill review simply drops those
   * rows rather than printing "Unknown", which would read as a finding about the agent.
   */
  const reviewMetadata = useMemo(() => {
    const out: ReviewSummaryMetadata[] = [];
    if (current?.reviewDate) {
      out.push({ label: 'Completed on', value: new Date(current.reviewDate).toLocaleString() });
    }
    if (current?.durationMs) {
      out.push({ label: 'Duration', value: formatDuration(current.durationMs) });
    }
    if (current?.modelSeries) {
      out.push({ label: 'Model', value: prettyModelSeries(current.modelSeries) });
    }
    // Stated whether or not any exist: "Ignored: 0" is the answer to "has anyone overridden this
    // review", and an absent row leaves the reader to guess that it means none.
    out.push({ label: 'Ignored', value: String(dismissal.keys.size) });
    if (current?.memoryEnabled !== undefined) {
      out.push({ label: 'Memory', value: current.memoryEnabled ? 'On' : 'Off' });
    }
    if (current?.webSearchEnabled !== undefined) {
      out.push({ label: 'Web search', value: current.webSearchEnabled ? 'On' : 'Off' });
    }

    // The pillars are what the composite is made of, and until now the page showed the composite
    // without ever naming them: a reader could see 62 but not which half of the rubric earned it,
    // nor that a pillar was withheld rather than scored zero.
    //
    // Revised rows are shown once decisions have been recorded, for the same reason the header is:
    // a stored breakdown beside a rescored headline makes the page contradict itself, because the
    // pillars no longer add up to the number printed above them.
    //
    // Paired by position, not by name: the rescore maps over this very list, so the two run in
    // lockstep. Keying on the name would collapse two rows that `parsePillars` normalised onto one
    // spelling into a single entry, and both would then report the last one's score.
    const storedPillars = scoredPillars(current?.pillars ?? []);
    const revisedPillars = rescored?.pillars ?? [];
    for (const [index, pillar] of storedPillars.entries()) {
      const revised = revisedPillars[index];
      const applicable = revised?.applicable ?? pillar.applicable;
      const score = revised ? revised.score : pillar.score;
      out.push({
        label: pillar.name,
        value: applicable && score !== null
          ? `${score} · ${pillar.weight}% weight`
          : `Not assessed · ${pillar.weight}% weight`,
      });
    }
    return out;
  }, [current, dismissal.keys, rescored]);

  /**
   * One button per reviewed agent, each carrying that agent's own score.
   *
   * A tab strip read as sections of one report, which is the wrong promise: these are separate
   * agents that were each reviewed, not chapters about one. Buttons say "pick a subject", and the
   * trailing score keeps the per-agent number visible now that the header above is the rollup.
   *
   * It renders for a single agent too. Hiding it below two agents — which both pickers used to do —
   * left a standard review with no label at all, so the page never said whose findings were on
   * screen. One agent is still worth naming.
   *
   * The score is the revised one for the agent being viewed, because the header is the mean of
   * exactly these numbers. Reading the stored score here left one value with two sources — the
   * rescore above, the rubric's original verdict below — so a single-agent review, where the mean
   * is just that agent's score, printed two different numbers for the same agent.
   */
  const buttonScore = (agent: (typeof agents)[number], storedScore: number | null): number | null => (
    overriddenScore !== undefined && overriddenScore !== null
      && agent.botId !== undefined && agent.botId === selected?.botId
      ? overriddenScore
      : storedScore
  );

  const agentTabs = agents.length > 0 ? (
    <div className={styles.agentRow} role="group" aria-label="Reviewed agents">
      {agents.map((agent, index) => {
        const value = agent.botId ?? `${agent.botName}-${index}`;
        const active = (selected?.botId ?? agents[0]?.botId) === agent.botId;
        // A withheld score says "nothing could be measured", which `0/100` would
        // report as a measured failure on the button itself.
        const shown = agent.review ? buttonScore(agent, agent.review.score) : undefined;
        return (
          <ToggleButton
            key={value}
            checked={active}
            appearance={active ? 'primary' : 'outline'}
            shape="rounded"
            icon={active ? <AgentsFilled /> : <AgentsRegular />}
            disabled={!orchestrated && !agent.review}
            onClick={() => setSelectedBot(agent.botId)}
          >
            {agent.botName}
            {shown === undefined ? '' : shown === null ? ' · Not scored' : ` · ${shown}/100`}
          </ToggleButton>
        );
      })}
    </div>
  ) : null;

  const runtimeReview = orchestrated && selected ? { ...review, botId: selected.botId, botName: selected.botName } : review;

  if (!review.botId && !orchestrated) {
    return (
      <EmptyState
        icon={PuzzlePieceRegular}
        title="This review has no target agent"
        description="Analysis is available for reviews that point at a Copilot Studio agent."
      />
    );
  }

  if (analysis.isPending) {
    return (
      <Skeleton aria-label="Loading analysis">
        <SkeletonItem size={56} />
        <div style={{ height: 24 }} />
        <SkeletonItem size={40} />
      </Skeleton>
    );
  }

  if (analysis.isError) {
    // Every failure behind this has a written explanation naming what is wrong. Replacing all of them
    // with one generic sentence hid an unparseable environment URL behind a message that named
    // nothing, which is why diagnosing it needed a script against live rows.
    const reason = analysis.error instanceof Error ? analysis.error.message : undefined;
    return (
      <EmptyState
        icon={PuzzlePieceRegular}
        title="We couldn't load the analysis"
        description={reason || 'The Agent Review Tool results could not be read from this environment.'}
        action={
          <Button appearance="primary" onClick={() => void analysis.refetch()}>
            Try again
          </Button>
        }
      />
    );
  }

  // A declarative agent is graded from an uploaded package against ART's own six-criterion DA
  // rubric — not the six agent pillars — and it has no bot behind it either, so it gets its own
  // panel for the same reason the skill review below does.
  if (selected?.declarativeAgentReview) {
    return (
      <div className={styles.root}>
        <DeclarativeAgentAnalysisPanel
          result={selected.declarativeAgentReview}
          agentName={selected.botName}
          header={agentTabs}
        />
      </div>
    );
  }

  // An uploaded skill has no ART agent review and never will: there is no bot behind it. Its
  // review is an artifact review, a different record with a different rubric, so it gets its own
  // panel rather than being squeezed into the pillar layout above.
  if (selected?.artifactReview) {
    return (
      <div className={styles.root}>
        <SkillAnalysisPanel result={selected.artifactReview} header={agentTabs} />
      </div>
    );
  }

  if (!current) {
    return (
      <div className={styles.root}>
      {agentTabs}
      <EmptyState
        icon={PuzzlePieceRegular}
        title={orchestrated ? 'No accepted agent review for this snapshot yet' : "This agent hasn't been reviewed yet"}
        description={orchestrated ? 'See the server assessment status above. Older standalone reviews are not substituted for snapshot evidence.' : 'Run a review in the Agent Review Tool, then come back here to see its components, scores and findings.'}
      />
      {orchestrated ? <RuntimePanel key={`${result?.id}:${runtimeReview.botId}`} review={runtimeReview} result={result} /> : null}
      </div>
    );
  }

  const rolledUp = analysis.data?.rolledUpScore ?? current.score;
  const reviewedCount = analysis.data?.reviewedCount ?? 1;
  const totalCount = analysis.data?.totalCount ?? 1;

  /**
   * The number in the header is the rollup, whichever agent is selected below it.
   *
   * It used to follow the selection, so switching tabs moved a figure captioned as the review's
   * score — the report appeared to change verdict on the same snapshot. The rollup is the review's
   * one answer; a per-agent score still sits on that agent's own button.
   *
   * An override is a decision about one agent, so it revises that agent's contribution to the mean
   * rather than replacing the mean outright. Substituting it wholesale would report one agent's
   * revised score as the whole system's.
   */
  const displayedScore = overriddenScore === undefined || overriddenScore === null || !selected
    ? rolledUp
    : aggregateScore(agents.map(agent => (
        agent.botId === selected.botId && agent.review
          ? { ...agent, review: { ...agent.review, score: overriddenScore } }
          : agent
      )));

  // Graded from whichever number is on screen, so the letter can never disagree with the score it
  // sits beside.
  const displayedGrade = displayedScore === null || displayedScore === undefined
    ? null
    : gradeForScore(displayedScore);

  const toolUrl = linkContext.data ? artService.appUrl(linkContext.data) : undefined;

  return (
    <div className={styles.root}>
      <div className={styles.scoreRow}>
        <ScoreSummary
          score={displayedScore ?? null}
          grade={displayedGrade}
          caption="Rolled up score"
          subCaption={
            totalCount === 1
              ? '1 target (Copilot Studio Agent)'
              : reviewedCount === totalCount
                ? `${totalCount} targets (${totalCount} x Copilot Studio Agents)`
                : `${reviewedCount} of ${totalCount} agents reviewed · mean`
          }
        />
      </div>

      {agentTabs}

      {/*
        First of the banners: it decides whether the rest of the page can be read at face value. A
        reader who reaches the findings before learning the workflow never answered has already
        drawn the wrong conclusion from them.
      */}
      {workflowOutcome?.notice ? (
        <MessageBar intent={workflowOutcome.notice.intent}>
          <MessageBarBody>
            <MessageBarTitle>{workflowOutcome.notice.title}</MessageBarTitle>
            {workflowOutcome.notice.body}
          </MessageBarBody>
        </MessageBar>
      ) : null}

      {!orchestrated && reviewedCount < totalCount ? (
        <MessageBar intent="info">
          <MessageBarBody>
            {totalCount - reviewedCount} connected agent
            {totalCount - reviewedCount === 1 ? ' has' : 's have'} never been reviewed, so
            {totalCount - reviewedCount === 1 ? ' it is' : ' they are'} not counted in the rolled up
            score. Review {totalCount - reviewedCount === 1 ? 'it' : 'them'} in the{' '}
            {toolUrl ? (
              <Link href={toolUrl} target="_blank" rel="noreferrer">
                Agent Review Tool
              </Link>
            ) : (
              'Agent Review Tool'
            )}{' '}
            to include {totalCount - reviewedCount === 1 ? 'it' : 'them'}.
          </MessageBarBody>
        </MessageBar>
      ) : null}

      {current.parsed ? null : (
        <MessageBar intent="warning">
          <MessageBarBody>
            This review was recorded before the current result format, so only its score is
            available. Run it again to see components and findings.
          </MessageBarBody>
        </MessageBar>
      )}

      <TabList selectedValue={tab} onTabSelect={(_, data) => setTab(data.value as string)}>
        <Tab value="findings">Agent review</Tab>
        <Tab value="map">
          {current?.displayPayload ? 'Architecture' : `Components (${current.components.length})`}
        </Tab>
        <Tab value="runtime">Runtime</Tab>
      </TabList>

      {tab === 'findings' ? (
        <>
          {dismissal.error ? (
            <MessageBar intent="error">
              <MessageBarBody>
                That decision was not saved. {dismissal.error} The rule has been put back as the
                review left it.
              </MessageBarBody>
            </MessageBar>
          ) : null}
          <ConsolidatedFindingsList
            view={consolidated}
            metadata={reviewMetadata}
            onSetAside={dismissal.setAside}
            setAsideBusy={dismissal.busy}
            ruleMeta={ruleMetaLookup}
            componentPanel={componentPanel}
            emptyMessage="This review was recorded before per-rule results were saved, so only its findings are available. Run it again to see the full list of checks."
          />
        </>
      ) : null}

      {/*
        The map draws the reviewed agent and everything it reaches, so it replaces the flat
        inventory wherever a copilot-harness payload exists. Standard and skill reviews persist no
        such payload — there is no graph to draw — so those keep the inventory.
      */}
      {tab === 'map' ? (
        current?.displayPayload ? (
          <AgentMapTab
            key={`${result?.id}:${selected?.botId}`}
            agentId={selected?.botId ?? ''}
            agentName={selected?.botName ?? 'Agent'}
            payload={current.displayPayload}
            orgUrl={current.sourceEnvironment ?? null}
            findings={mapFindings}
            onOpenFinding={() => setTab('findings')}
            useConnectedAgent={useConnectedAgentMap}
          />
        ) : (
          <ComponentInventory components={current.components} findings={current.findings} />
        )
      ) : null}

      {tab === 'runtime' ? <RuntimePanel key={`${result?.id}:${selected?.botId}`} review={runtimeReview} result={result} /> : null}
    </div>
  );
}
