/**
 * Runtime tab — what the agent actually did in production, as opposed to how it is configured.
 *
 * The ordering of the sections is the argument this panel makes: failures first, then where time goes,
 * then what is being leaned on, then what is being paid for and ignored. A reader who stops after the
 * first section should still have the most actionable thing.
 *
 * Each lens is a list of things that went wrong or ran slowly, not a grid of numbers. A table asks the
 * reader to carry a row across six columns before it means anything; a row that states the problem and
 * opens onto its own evidence, cause and fix reads the same way the findings list does, which is the
 * screen immediately next to this one.
 *
 * Scoped to one snapshot. The date range is the snapshot's own, chosen when it was created, and is
 * shown read-only — changing the window is what taking a new snapshot means.
 */

import { useCallback, useMemo, useState } from 'react';
import {
  Badge,
  Body1,
  Button,
  Caption1,
  Link,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  ProgressBar,
  Spinner,
  Subtitle2,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ClockRegular,
  DatabaseSearchRegular,
  WrenchRegular,
} from '@fluentui/react-icons';
import { EmptyState } from '../../../shared/components/EmptyState';
import { MetricCard } from '@review-ui/MetricCard';
import { ExpandableRow, ExpandableRowList, RowSection, type ResultTone } from '@review-ui/ExpandableRow';
import { RuntimeMetrics, type RuntimeMetricsSummary } from '@review-ui/RuntimeMetrics';
import { RuntimeAnalysisToolbar, type RuntimeLens } from '@review-ui/RuntimeAnalysisToolbar';
import {
  RuntimeErrorList,
  RuntimeExampleChips,
  type RuntimeErrorExample,
  type RuntimeErrorGroup,
} from '@review-ui/RuntimeErrorList';
import { useArtLinkContext } from '../hooks/use-art';
import { useResultRuntimeReport, useRuntimeAnalysis, useRuntimePreflight } from '../hooks/use-runtime';
import {
  KNOWLEDGE_CONFIDENCE_HINT,
  KNOWLEDGE_CONFIDENCE_LABEL,
  type ErrorGroup,
  type KnowledgeConfidence,
  type KnowledgeUsageGroup,
  type RuntimeReport,
  type TopicNodeGroup,
} from '../models/runtime';
import type { Review, ReviewResult } from '../models/review';
import { artService } from '../services/art-service';
import { isOrchestrated } from '../services/snapshot-orchestration';
import { useOrchestration } from '../hooks/use-orchestration';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  tiles: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
    gap: tokens.spacingHorizontalM,
  },
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  sectionHead: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  recommendation: { color: tokens.colorNeutralForeground2 },
  /** The numbers a row carries on its right-hand side, before it is opened. */
  meta: { display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  facts: {
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: tokens.spacingHorizontalXL,
    rowGap: tokens.spacingVerticalXS,
  },
  fact: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  factLabel: { color: tokens.colorNeutralForeground3 },
  badges: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: tokens.spacingHorizontalXS,
  },
  bar: {
    height: '6px',
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorBrandBackground,
    minWidth: '2px',
  },
  barTrack: {
    width: '100%',
    maxWidth: '320px',
    height: '6px',
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: tokens.colorNeutralBackground4,
  },
  progress: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
});

/** Evidence strength, as the row's own verdict. A glance separates proven use from retrieval overhead. */
const CONFIDENCE_TONE: Record<KnowledgeConfidence, ResultTone> = {
  ConfirmedUsed: 'pass',
  LikelyUsed: 'info',
  RetrievedOnly: 'warning',
  SelectedOnly: 'warning',
  NeverUsed: 'error',
};

/** Domains listed inside an aggregate row. Enough to show where the traffic goes without a wall of text. */
const SITES_SHOWN = 5;

/** Example conversations linked per row. The rest are counted rather than listed. */
const EXAMPLES_SHOWN = 3;

/**
 * Numbered links out to the conversations behind a row.
 *
 * Examples are numbered rather than identified. A conversation id is two joined GUIDs and names
 * nothing a reader recognises; what matters is that there are three of them and each one opens.
 * When no link can be built the chips are dropped rather than printed dead — an id with nowhere to
 * go is noise, and the row's own counts already carry the scale.
 */
function toTranscriptExamples(
  conversationIds: readonly string[] | undefined,
  linkFor?: (conversationId: string) => string | undefined,
): RuntimeErrorExample[] {
  return (conversationIds ?? [])
    .slice(0, EXAMPLES_SHOWN)
    .map((id, index) => ({ label: `Transcript ${index + 1}`, href: linkFor?.(id) }))
    .filter((example) => example.href !== undefined);
}

/**
 * Turns the report's error groups into the rows the shared list renders.
 *
 * The mapping is where this panel's vocabulary meets the shared component's: an error *type* is the
 * row title because that is the thing a reader fixes once, and its share of all errors is the badge
 * because a type that is 60% of the failures is a different problem from one that is 2%.
 */
function toErrorGroups(
  errors: ErrorGroup[],
  linkFor?: (conversationId: string) => string | undefined,
): RuntimeErrorGroup[] {
  return errors.slice(0, 10).map((error) => ({
    id: error.typeKey,
    title: error.type,
    kind: error.failedComponent ? `${error.category} · ${error.failedComponent}` : error.category,
    sharePercent: error.percentOfErrors,
    occurrences: error.count,
    examples: toTranscriptExamples(error.exampleConversationIds, linkFor),
    reported: error.sampleMessages[0],
    cause: error.rootCause,
    recommendation: error.recommendation,
  }));
}

function ms(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '-';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(1)} s`;
}

function percent(value: number): string {
  if (!Number.isFinite(value)) return '-';
  return `${value.toFixed(1)}%`;
}

/** A share-of-total bar. Relative to the leader, so the top row always fills. */
function ShareBar({ value, max }: { value: number; max: number }) {
  const styles = useStyles();
  const width = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className={styles.barTrack}>
      <div className={styles.bar} style={{ width: `${width}%` }} />
    </div>
  );
}

/**
 * Adapter over the shared `MetricCard`.
 *
 * The card itself lives in the Makers app so both products render these numbers identically; this
 * wrapper keeps the panel's existing call sites and its `hint` vocabulary unchanged.
 */
function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return <MetricCard label={label} value={value} detail={hint} />;
}

/**
 * One labelled number inside an opened row.
 *
 * The table columns these replace were only ever read one row at a time — a reader comparing two
 * tools looked at the same cell twice rather than scanning down. Stating the label next to its own
 * value costs a little width and removes the need to look back up at a header.
 */
function Fact({ label, value }: { label: string; value: string }) {
  const styles = useStyles();
  return (
    <div className={styles.fact}>
      <Caption1 className={styles.factLabel}>{label}</Caption1>
      <Text weight="semibold">{value}</Text>
    </div>
  );
}

export interface RuntimePanelProps {
  review: Review | undefined;
  result: ReviewResult | undefined;
}

/** The snapshot's window as the toolbar's pickers want it. */
function rangeDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function RuntimePanel({ review, result }: RuntimePanelProps) {
  const styles = useStyles();
  const agentId = review?.botId;
  const resultId = result?.id;
  const [lens, setLens] = useState<RuntimeLens>('errors');

  const orchestrated = isOrchestrated(result);
  const progress = useOrchestration(result);
  const assessment = progress.data?.progress?.assessments.find(item => item.stage === 'runtime' && item.agentId === agentId);
  const preflight = useRuntimePreflight(
    agentId,
    review?.environmentUrl,
    result?.transcriptStart,
    result?.transcriptEnd,
  );
  const stored = useResultRuntimeReport(resultId, agentId, result);
  // Runs are followed in both modes. The snapshot flow used to leave parked jobs to a server-side
  // driver flow; that flow is gone, so the only thing that can carry one forward is the person
  // looking at it - which is also the only thing that can tell them it stopped.
  const run = useRuntimeAnalysis(resultId, agentId);
  const linkContext = useArtLinkContext();

  // Built once per report rather than per row: every example link differs only by conversation id, and
  // the agent and environment behind them are fixed for the whole snapshot.
  const debuggerLink = useCallback(
    (conversationId: string) =>
      linkContext.data
        ? artService.debuggerUrl({
            conversationId,
            agentId,
            agentName: review?.botName,
            environmentUrl: review?.environmentUrl,
            context: linkContext.data,
          })
        : undefined,
    [agentId, linkContext.data, review?.botName, review?.environmentUrl],
  );

  // The live run wins while one is in flight; otherwise show what this snapshot already recorded.
  const report = run.job?.report ?? stored.data?.report;

  const handleRun = () => {
    if (!agentId || orchestrated) return;
    run.start({
      agentId,
      agentName: review?.botName,
      resultId,
      rangeStart: result?.transcriptStart,
      rangeEnd: result?.transcriptEnd,
      environmentUrl: review?.environmentUrl,
    });
  };

  if (!agentId) {
    return (
      <EmptyState
        icon={ClockRegular}
        title="This review isn't linked to an agent"
        description="Runtime analysis reads the conversation transcripts of a specific agent, so it needs a review that targets one."
      />
    );
  }

  const blocked = preflight.data && !preflight.data.canRun;

  // When this was analysed. The run is a snapshot, so the reader needs its date to know what the
  // numbers below describe.
  const provenance: string[] = [];
  if (stored.data?.createdOn && !run.isRunning) {
    provenance.push(`analysed ${new Date(stored.data.createdOn).toLocaleString()}`);
  }

  return (
    <div className={styles.root}>
      <RuntimeAnalysisToolbar
        lens={lens}
        onLensChange={setLens}
        from={rangeDate(result?.transcriptStart)}
        to={rangeDate(result?.transcriptEnd)}
        // The window belongs to the snapshot, so the pickers report it rather than set it.
        onRangeChange={() => undefined}
        rangeReadOnly
        onAnalyze={orchestrated ? undefined : handleRun}
        analyzing={run.isStarting || run.isRunning}
        disabled={preflight.isPending || blocked}
      />

      {/* When it was analysed. Kept to one line so the metrics below stay above the fold. */}
      {provenance.length > 0 ? (
        <Caption1 className={styles.recommendation}>{provenance.join(' · ')}</Caption1>
      ) : null}

      {preflight.data?.message ? (
        <MessageBar intent={preflight.data.canRun ? 'warning' : 'error'}>
          <MessageBarBody>
            <MessageBarTitle>
              {preflight.data.canRun ? 'Heads up' : 'Runtime analysis is unavailable'}
            </MessageBarTitle>
            {preflight.data.message}
          </MessageBarBody>
        </MessageBar>
      ) : null}

      {orchestrated && (stored.isError || assessment?.error) ? <MessageBar intent="error"><MessageBarBody>
        {stored.error?.message ?? assessment?.error}
        {stored.isError ? <Button disabled={stored.isFetching} onClick={() => void stored.refetch()}>Retry reading retained evidence</Button> : null}
      </MessageBarBody></MessageBar> : null}
      {run.error ? (
        <MessageBar intent="error">
          <MessageBarBody>
            <MessageBarTitle>The analysis stopped</MessageBarTitle>
            {run.error}
          </MessageBarBody>
        </MessageBar>
      ) : null}

      {run.canContinue && run.job ? (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>
              {run.continueReason === 'stalled'
                ? 'The analysis stopped before finishing'
                : 'There are more conversations to analyse'}
            </MessageBarTitle>
            {run.job.transcriptsProcessed.toLocaleString()} conversations analysed so far
            {run.job.report ? ', shown below' : ''}.{' '}
            {run.continueReason === 'stalled'
              ? 'It has not recorded any progress for a while. Continuing picks up from the last completed batch; nothing already analysed is read again.'
              : 'Dataverse limits how many batches run in one go. Continuing picks up exactly where it left off.'}{' '}
            Keeping these results ends the analysis here and records what has been analysed as this
            snapshot&rsquo;s evidence.
          </MessageBarBody>
          <MessageBarActions>
            <Button
              appearance="primary"
              disabled={run.isContinuing || run.isFinishing}
              onClick={run.continueRun}
            >
              {run.isContinuing ? 'Continuing…' : 'Continue analysis'}
            </Button>
            {run.job.report ? (
              <Button disabled={run.isContinuing || run.isFinishing} onClick={run.finishRun}>
                {run.isFinishing ? 'Keeping…' : 'Keep these results'}
              </Button>
            ) : null}
          </MessageBarActions>
        </MessageBar>
      ) : null}

      {run.isRunning ? (
        <div className={styles.progress}>
          <ProgressBar />
          <Caption1>
            {run.job?.lastStatus ??
              'Queued. Large agents are analysed in batches; this can take a few minutes.'}
          </Caption1>
          {run.job?.transcriptsProcessed ? (
            <Caption1 className={styles.recommendation}>
              {run.job.transcriptsProcessed.toLocaleString()} conversations analysed so far
            </Caption1>
          ) : null}
        </div>
      ) : null}

      {stored.isPending && !report ? <Spinner label="Loading this snapshot's analysis…" /> : null}

      {report ? (
        <ReportView report={report} lens={lens} debuggerLink={debuggerLink} />
      ) : !run.isRunning && !stored.isPending && !blocked ? (
        <EmptyState
          icon={ClockRegular}
          title="No runtime analysis for this snapshot"
          description={orchestrated ? 'No accepted runtime evidence is available for this agent and snapshot.' : "Run an analysis to see the errors, slow steps, tools and knowledge sources behind this agent's real conversations in the snapshot's date range."}
        />
      ) : null}
    </div>
  );
}

function ReportView({
  report,
  lens,
  debuggerLink,
}: {
  report: RuntimeReport;
  lens: RuntimeLens;
  debuggerLink?: (conversationId: string) => string | undefined;
}) {
  const styles = useStyles();

  const maxToolCalls = useMemo(
    () => report.tools.reduce((max, tool) => Math.max(max, tool.calls), 0),
    [report.tools],
  );
  const maxKnowledge = useMemo(
    () => report.knowledge.reduce((max, source) => Math.max(max, source.retrievedSearches), 0),
    [report.knowledge],
  );

  // The tiles, their formatting and the step-versus-tool timing fallback all live in the shared
  // component so this tab and the Agent Review Tool cannot drift into two different-looking screens.
  const summary = useMemo<RuntimeMetricsSummary>(() => {
    const toolCalls = report.tools.reduce((total, tool) => total + tool.calls, 0);
    const toolElapsed = report.tools.reduce((total, tool) => total + tool.totalMs, 0);
    return {
      transcriptsAnalyzed: report.transcriptsAnalyzed,
      transcriptRowsAnalyzed: report.transcriptRowsAnalyzed,
      conversationsWithErrors: report.conversationsWithErrors,
      errorRatePercent: report.errorRatePercent,
      uniqueErrorTypes: report.uniqueErrorTypes,
      totalErrors: report.totalErrors,
      totalToolCalls: report.totalToolCalls,
      avgStepMs: report.avgStepMs,
      totalSteps: report.totalSteps,
      avgToolMs: toolCalls > 0 ? toolElapsed / toolCalls : undefined,
      totalKnowledgeSearches: report.totalKnowledgeSearches,
      knowledgeConfiguredButUnused:
        report.knowledgeTraces > 0 && report.knowledgeTracesWithSearch === 0,
    };
  }, [report]);

  return (
    <div className={styles.root}>
      <RuntimeMetrics summary={summary} />

      <CoverageNote report={report} />

      {lens === 'errors' ? <ErrorsView report={report} debuggerLink={debuggerLink} /> : null}
      {lens === 'latency' ? (
        <LatencyView report={report} max={maxToolCalls} debuggerLink={debuggerLink} />
      ) : null}
      {lens === 'knowledge' ? (
        <KnowledgeView report={report} max={maxKnowledge} debuggerLink={debuggerLink} />
      ) : null}
    </div>
  );
}

/**
 * Says so when the report does not cover everything it was asked to.
 *
 * Unreadable rows and unfollowed connected agents used to be visible only in the plugin trace, so a
 * report missing a child agent's entire tool and knowledge activity looked exactly like one that had
 * nothing to miss. Silent by design when there is nothing to declare.
 */
function CoverageNote({ report }: { report: RuntimeReport }) {
  const styles = useStyles();

  const notes: string[] = [];
  if (report.transcriptRowsUnreadable > 0) {
    notes.push(
      `${report.transcriptRowsUnreadable.toLocaleString()} transcript ${
        report.transcriptRowsUnreadable === 1 ? 'row' : 'rows'
      } could not be read and ${report.transcriptRowsUnreadable === 1 ? 'is' : 'are'} not counted`,
    );
  }
  if (report.connectedConversationsNotFollowed > 0) {
    notes.push(
      `${report.connectedConversationsNotFollowed.toLocaleString()} conversations that handed off to a connected agent were not followed, so that agent's tools and knowledge are missing`,
    );
  }

  if (notes.length === 0) return null;

  return (
    <MessageBar intent="warning">
      <MessageBarBody>
        <Caption1 className={styles.recommendation}>{notes.join('. ')}.</Caption1>
      </MessageBarBody>
    </MessageBar>
  );
}

function ErrorsView({
  report,
  debuggerLink,
}: {
  report: RuntimeReport;
  debuggerLink?: (conversationId: string) => string | undefined;
}) {
  const styles = useStyles();
  const groups = useMemo(
    () => toErrorGroups(report.errors, debuggerLink),
    [report.errors, debuggerLink],
  );

  return (
    <RuntimeErrorList
      groups={groups}
      omitted={report.errorTypesOmitted}
      empty={
        <Body1 className={styles.recommendation}>
          No errors were found in the analysed conversations.
        </Body1>
      }
    />
  );
}

/** Marks a list as the top slice rather than the whole set. */
function OmittedNote({ count, noun }: { count: number; noun: string }) {
  const styles = useStyles();
  if (count <= 0) return null;

  return (
    <Caption1 className={styles.recommendation}>
      {count.toLocaleString()} further {noun} are not listed. The totals above cover all of them.
    </Caption1>
  );
}

function LatencyView({
  report,
  max,
  debuggerLink,
}: {
  report: RuntimeReport;
  max: number;
  debuggerLink?: (conversationId: string) => string | undefined;
}) {
  const styles = useStyles();

  // Classic topic nodes share this list with plan steps rather than getting a place of their own,
  // because to a reader they are the same question — what did this agent spend its run doing. They
  // differ only in that they carry no time, so they follow the timed rows instead of interleaving
  // with them, and the heading and caption only change when there are any.
  const allTopics = report.topicNodes ?? [];
  const topics = allTopics.slice(0, 10);
  const steps = report.nodes.slice(0, 10);

  // The analyzer has already dropped topics to stay inside its own bound, and this list drops more
  // to match the ten steps beside it. The note has to carry both numbers or it understates what is
  // missing by however many this slice took.
  const topicsOmitted = (report.topicNodesOmitted ?? 0) + (allTopics.length - topics.length);

  return (
    <div className={styles.root}>
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <ClockRegular />
          <Subtitle2>{topics.length > 0 ? 'Steps and topics' : 'Slowest steps'}</Subtitle2>
        </div>
        {steps.length === 0 && topics.length === 0 ? (
          <Body1 className={styles.recommendation}>
            No plan-step timings were recorded. Not every agent writes them. Where they are missing,
            per-tool timings below carry the latency for this agent.
          </Body1>
        ) : (
          <>
            {steps.length === 0 ? (
              <Body1 className={styles.recommendation}>
                This agent ran classic topics rather than generative plan steps, so there are no step
                timings to rank. What it ran is listed below.
              </Body1>
            ) : null}
            {topics.length > 0 ? (
              <Caption1 as="p" className={styles.recommendation}>
                Topic rows carry no time. Copilot Studio records a classic topic node as a single
                instant rather than as a start and an end, so any duration shown for one would be
                invented rather than measured.
              </Caption1>
            ) : null}
            <ExpandableRowList>
              {steps.map((node) => (
                <ExpandableRow
                  key={node.key}
                  title={node.name}
                  tags={[node.kind]}
                  // Average first: the slowest single run is the tail, the average is the experience.
                  meta={
                    <span className={styles.meta}>
                      <Badge shape="rounded" appearance="filled" color="subtle" size="small">
                        {percent(node.percentOfTime)}
                      </Badge>
                      {ms(node.avgMs)} average
                    </span>
                  }
                >
                  <div className={styles.facts}>
                    <Fact label="Runs" value={node.calls.toLocaleString()} />
                    <Fact label="Average" value={ms(node.avgMs)} />
                    <Fact label="Slowest run" value={ms(node.maxMs)} />
                    <Fact label="Share of total time" value={percent(node.percentOfTime)} />
                    {node.failureCount > 0 ? (
                      <Fact label="Failures" value={node.failureCount.toLocaleString()} />
                    ) : null}
                  </div>
                  {node.capability ? (
                    <RowSection label="Capability">{node.capability}</RowSection>
                  ) : null}
                </ExpandableRow>
              ))}
              {topics.map((topic) => (
                <TopicRow key={`topic:${topic.key}`} topic={topic} debuggerLink={debuggerLink} />
              ))}
            </ExpandableRowList>
          </>
        )}
        <OmittedNote count={report.nodesOmitted} noun="steps" />
        <OmittedNote count={topicsOmitted} noun="topics" />
      </section>

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <WrenchRegular />
          <Subtitle2>Tools, most to least used</Subtitle2>
        </div>
        {report.tools.length === 0 ? (
          <Body1 className={styles.recommendation}>
            This agent made no tool or connected-agent calls in the analysed conversations.
          </Body1>
        ) : (
          <ExpandableRowList>
            {report.tools.map((tool) => (
              <ExpandableRow
                key={`${tool.kind}:${tool.name}`}
                title={tool.name}
                tags={[tool.kind]}
                // A failing tool is the reason to open this row, so the count is on the outside of it.
                tone={tool.errorCount > 0 ? 'warning' : undefined}
                toneLabel={
                  tool.errorCount > 0
                    ? `${tool.errorCount.toLocaleString()} failed`
                    : undefined
                }
                meta={
                  <span className={styles.meta}>
                    <Badge shape="rounded" appearance="filled" color="subtle" size="small">
                      {percent(tool.percentOfCalls)}
                    </Badge>
                    {tool.calls.toLocaleString()} calls
                  </span>
                }
              >
                <div className={styles.facts}>
                  <Fact label="Calls" value={tool.calls.toLocaleString()} />
                  <Fact label="Conversations" value={tool.conversationReach.toLocaleString()} />
                  <Fact label="Average" value={ms(tool.avgMs)} />
                  <Fact label="Slowest call" value={ms(tool.maxMs)} />
                  <Fact
                    label="Failures"
                    value={tool.errorCount > 0 ? tool.errorCount.toLocaleString() : 'None'}
                  />
                </div>
                {/* Reach is the number that catches a loop: many calls inside few conversations is
                    one conversation retrying, not a popular tool. */}
                <RowSection label="Share of all tool calls">
                  <ShareBar value={tool.calls} max={max} />
                </RowSection>
              </ExpandableRow>
            ))}
          </ExpandableRowList>
        )}
        <OmittedNote count={report.toolsOmitted} noun="tools" />
      </section>
    </div>
  );
}

/**
 * One classic topic, rendered into the same list as the timed plan steps above it.
 *
 * It carries no time and must not appear to. Every node execution Copilot Studio reports has an
 * identical start and end, so a duration here would be a fabricated zero that reads as an
 * instantaneous step rather than as an unmeasured one. The row states conversation reach instead,
 * which is the thing it can honestly measure.
 *
 * Reach also leads rather than executions, because executions count nodes: a ten-node topic entered
 * by twenty conversations outranks a one-node topic entered by five by forty times when the honest
 * ratio is four.
 */
function TopicRow({
  topic,
  debuggerLink,
}: {
  topic: TopicNodeGroup;
  debuggerLink?: (conversationId: string) => string | undefined;
}) {
  const styles = useStyles();

  // HTML collapses leading and trailing space, so two topics differing only by it would render as
  // one row with nothing to show for the difference. Naming the anomaly beats printing an indent the
  // reader can see but not measure. "Unknown" matches what the parser already writes for a nameless
  // topic, rather than introducing a second spelling for one condition.
  const trimmed = topic.topic.trim();
  const hasEdgeSpace = trimmed !== topic.topic;

  // Escalation is the only outcome here that asks anyone to act. Ending the conversation is how a
  // healthy one finishes — a feedback topic is typically the largest single source of it — so it is
  // never badged as a failure, and an unreported exit is a node type that emits none, not a fault.
  const escalated = topic.escalatedCount > 0;

  const examples = useMemo(
    () => toTranscriptExamples(topic.exampleConversationIds, debuggerLink),
    [topic.exampleConversationIds, debuggerLink],
  );

  return (
    <ExpandableRow
      title={trimmed.length > 0 ? trimmed : 'Unknown'}
      tags={hasEdgeSpace ? ['Topic', 'Name has surrounding spaces'] : ['Topic']}
      tone={escalated ? 'warning' : undefined}
      toneLabel={escalated ? `${topic.escalatedCount.toLocaleString()} escalated` : undefined}
      meta={
        <span className={styles.meta}>
          {topic.conversationReach.toLocaleString()}{' '}
          {topic.conversationReach === 1 ? 'conversation' : 'conversations'}
        </span>
      }
    >
      <div className={styles.facts}>
        <Fact label="Conversations reached" value={topic.conversationReach.toLocaleString()} />
        <Fact label="Node executions" value={topic.executions.toLocaleString()} />
        <Fact label="Completed" value={topic.succeededCount.toLocaleString()} />
        {topic.escalatedCount > 0 ? (
          <Fact label="Escalated" value={topic.escalatedCount.toLocaleString()} />
        ) : null}
        {topic.cancelledCount > 0 ? (
          <Fact label="Ended the conversation" value={topic.cancelledCount.toLocaleString()} />
        ) : null}
        {topic.waitingCount > 0 ? (
          <Fact label="Waiting" value={topic.waitingCount.toLocaleString()} />
        ) : null}
        {topic.otherExitCount > 0 ? (
          <Fact label="Exit not reported" value={topic.otherExitCount.toLocaleString()} />
        ) : null}
      </div>

      {examples.length > 0 ? (
        <RowSection label="Examples">
          <RuntimeExampleChips examples={examples} />
        </RowSection>
      ) : null}
    </ExpandableRow>
  );
}

/**
 * Knowledge usage, graded by how strongly the transcripts support it.
 *
 * The columns deliberately keep retrieval and citation apart. A source being returned by a search is
 * not evidence that an answer used it — collapsing the two into a single "usage" number is what made
 * the previous version report sources as used when the answer had explicitly rejected them.
 */
function KnowledgeView({
  report,
  max,
  debuggerLink,
}: {
  report: RuntimeReport;
  max: number;
  debuggerLink?: (conversationId: string) => string | undefined;
}) {
  const styles = useStyles();

  const neverUsed = useMemo(
    // Only a configured source can be a removal candidate. An aggregate category has nothing to detach.
    () => report.knowledge.filter((source) => source.confidence === 'NeverUsed' && source.configured),
    [report.knowledge],
  );

  if (report.knowledge.length === 0) {
    // Three distinct empty states, and conflating them would mislead. No knowledge steps at all means
    // none is configured, which is not a finding. Steps that never searched means it is configured and
    // idle, which is.
    if (report.knowledgeTraces > 0 && report.knowledgeTracesWithSearch === 0) {
      return (
        <MessageBar intent="warning">
          <MessageBarBody>
            <MessageBarTitle>Knowledge is configured but never searched</MessageBarTitle>
            Knowledge ran in {report.knowledgeTraces.toLocaleString()} conversations without performing a
            single search. The agent is carrying knowledge it does not use. Check that its instructions
            and topic routing actually reach it.
          </MessageBarBody>
        </MessageBar>
      );
    }
    return (
      <Body1 className={styles.recommendation}>
        No knowledge sources were used in the analysed conversations.
      </Body1>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.tiles}>
        <Tile
          label="Sources configured"
          value={report.knowledgeSourcesConfigured.toLocaleString()}
          hint="Attached to the agent"
        />
        <Tile
          label="Confirmed used"
          value={report.knowledgeSourcesCited.toLocaleString()}
          hint="An answer cited them"
        />
        <Tile
          label="Never used"
          value={report.knowledgeSourcesNeverUsed.toLocaleString()}
          hint="No runtime evidence at all"
        />
        <Tile
          label="Knowledge searches"
          value={report.totalKnowledgeSearches.toLocaleString()}
          hint={`${report.answersWithoutCitations.toLocaleString()} answers cited nothing`}
        />
      </div>

      {report.answersWithoutCitations > 0 ? (
        <MessageBar intent="info">
          <MessageBarBody>
            <MessageBarTitle>Some answers cannot be attributed</MessageBarTitle>
            {report.answersWithoutCitations.toLocaleString()} answers retrieved knowledge but cited none
            of it. Those searches are counted as retrievals, never as usage, so a source here is only
            reported as used when an answer pointed at it.
          </MessageBarBody>
        </MessageBar>
      ) : null}

      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <DatabaseSearchRegular />
          <Subtitle2>Knowledge sources, most to least used</Subtitle2>
        </div>
        <ExpandableRowList>
          {report.knowledge.map((source) => (
            <KnowledgeRow
              key={source.key}
              source={source}
              max={max}
              debuggerLink={debuggerLink}
            />
          ))}
        </ExpandableRowList>
        {report.knowledgeSourcesOmitted > 0 ? (
          <Caption1 className={styles.recommendation}>
            {report.knowledgeSourcesOmitted.toLocaleString()} further configured sources are not listed.
            The counts above cover all of them.
          </Caption1>
        ) : null}
      </section>

      {neverUsed.length > 0 ? (
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <WrenchRegular />
            <Subtitle2>Removal candidates</Subtitle2>
          </div>
          <Body1 className={styles.recommendation}>
            These sources are attached to the agent but were never searched, returned or cited in the
            analysed period. Confirm against a longer range before detaching any of them.
            {report.knowledgeSourcesNeverUsed > neverUsed.length
              ? ` Showing ${neverUsed.length} of ${report.knowledgeSourcesNeverUsed.toLocaleString()}.`
              : ''}
          </Body1>
          <div className={styles.badges}>
            {neverUsed.map((source) => (
              <Badge shape="rounded" key={source.key} appearance="tint" color="danger" size="small">
                {source.name}
              </Badge>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function KnowledgeRow({
  source,
  max,
  debuggerLink,
}: {
  source: KnowledgeUsageGroup;
  max: number;
  debuggerLink?: (conversationId: string) => string | undefined;
}) {
  const styles = useStyles();

  // An aggregate row stands for many one-off results rather than a single source, so it says how many it
  // absorbed and which domains they came from. Without that it reads as a black box.
  const sites = useMemo(
    () =>
      Object.entries(source.sites ?? {})
        .sort((a, b) => b[1] - a[1])
        .slice(0, SITES_SHOWN),
    [source.sites],
  );
  const pages = source.pagesReturned ?? 0;
  const isAggregate = pages > 0 || sites.length > 0;
  const unseen = source.retrievedSearches === 0 && source.citedAnswers === 0;

  // Cited before merely retrieved, matching what the shared JSON report already does. A conversation
  // whose answer pointed at this source proves use; one that only retrieved it proves the search ran.
  // Offering the weaker evidence first would invite the reader to check the wrong transcript.
  const examples = useMemo(() => {
    const cited = source.citedConversationIds ?? [];
    return toTranscriptExamples(
      cited.length > 0 ? cited : source.exampleConversationIds,
      debuggerLink,
    );
  }, [source.citedConversationIds, source.exampleConversationIds, debuggerLink]);

  return (
    <ExpandableRow
      title={source.name}
      tags={[source.sourceType]}
      // The evidence grade is the whole point of the row, so it is the thing on the outside of it.
      tone={CONFIDENCE_TONE[source.confidence]}
      toneLabel={KNOWLEDGE_CONFIDENCE_LABEL[source.confidence]}
      meta={
        <span className={styles.meta}>
          {unseen ? null : (
            <Badge shape="rounded" appearance="filled" color="subtle" size="small">
              {percent(source.citationRatePercent)} cited
            </Badge>
          )}
          {source.retrievedSearches.toLocaleString()} retrieved
        </span>
      }
    >
      <RowSection label="Evidence">{KNOWLEDGE_CONFIDENCE_HINT[source.confidence]}</RowSection>

      {/* Retrieval and citation stay apart. A source being returned by a search is not evidence that
          an answer used it, and collapsing the two is what made the previous version report rejected
          sources as used. */}
      <div className={styles.facts}>
        <Fact label="Retrieved" value={source.retrievedSearches.toLocaleString()} />
        <Fact label="Cited by an answer" value={source.citedAnswers.toLocaleString()} />
        <Fact label="Citation rate" value={unseen ? '-' : percent(source.citationRatePercent)} />
        <Fact label="Conversations" value={source.conversationReach.toLocaleString()} />
        {source.configured ? null : <Fact label="On this agent" value="Not configured" />}
      </div>

      {examples.length > 0 ? (
        <RowSection label="Examples">
          <RuntimeExampleChips examples={examples} />
        </RowSection>
      ) : null}

      {unseen ? null : (
        <RowSection label="Share of all retrievals">
          <ShareBar value={source.retrievedSearches} max={max} />
        </RowSection>
      )}

      {isAggregate ? (
        <RowSection label="What this row covers">
          {`${pages.toLocaleString()} results across ${Object.keys(source.sites ?? {}).length.toLocaleString()} sites`}
          {sites.length > 0 ? (
            <Caption1 as="p" className={styles.recommendation}>
              {sites.map(([site, count]) => `${site} (${count})`).join(' · ')}
            </Caption1>
          ) : null}
        </RowSection>
      ) : null}

      {source.url ? (
        <RowSection label="Source">
          <Link href={source.url} target="_blank" rel="noreferrer">
            {source.url}
          </Link>
        </RowSection>
      ) : null}
    </ExpandableRow>
  );
}
