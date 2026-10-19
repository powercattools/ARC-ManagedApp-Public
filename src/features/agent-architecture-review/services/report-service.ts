/**
 * Builds the shareable report.
 *
 * Pure functions over data, with no Dataverse or React dependency, because the interesting logic here
 * is a join between two sources that disagree about what "absent" means and that deserves to be
 * testable without a mock environment.
 *
 * The whole file exists to serve one asymmetry: **design data is complete, runtime data is a sample.**
 * ART knows every tool an agent is configured with. The runtime analyzer only knows what it saw in the
 * transcripts it read. So "which tools are never called" cannot be answered by either source alone —
 * it is the design inventory minus the observed set, and it is only a safe question to ask when the
 * runtime sample observed enough to make absence meaningful.
 */

import {
  CITATION_NOTE,
  MAX_EXAMPLE_CONVERSATIONS,
  MAX_SAMPLE_MESSAGES,
  OBSERVED_USE_NOTE,
  REPORT_SCHEMA_VERSION,
  type CapabilityUse,
  type CapabilityUseSummary,
  type ShareReport,
  type ShareReportAgent,
  type ShareReportErrorGroup,
  type ShareReportRuntime,
} from '../models/report';
import type { AggregatedReview, ArtComponent, ArtReview } from '../models/art';
import type { Review, ReviewResult } from '../models/review';
import type { RuntimeJob, RuntimeReport } from '../models/runtime';

export interface BuildShareReportInput {
  orchestration?: import('../models/orchestration').OrchestrationProgress;
  review: Review;
  snapshot: ReviewResult;
  aggregated: AggregatedReview;
  /** Runtime analyses for this snapshot, keyed by lowercased agent id. */
  runtimeByAgent: ReadonlyMap<string, RuntimeJob>;
  /**
   * This app's own score per agent, keyed by lowercased agent id, when it has one.
   *
   * Supplied rather than read from the aggregated review because the two answer different
   * questions: the review carries the rubric's original verdict, while this carries it as revised
   * by the rules a reviewer set aside. A report exported from a page showing the revised number
   * must print that number, or the document contradicts the screen it was taken from. An absent
   * entry falls back to the review's own score, so a snapshot with no agent rows still reports.
   */
  scoreByAgent?: ReadonlyMap<string, number | null>;
  /** Injected so the output is deterministic under test. */
  generatedOn?: Date;
}

/**
 * Normalises a capability name for matching across the two sources.
 *
 * Case and whitespace only. It is tempting to strip punctuation too, but ART names and transcript
 * names are both author-supplied and a more aggressive normaliser starts merging genuinely distinct
 * capabilities — a false "observed" is worse than a false "not observed", because it silently credits
 * a tool that never ran.
 */
function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Trims runtime evidence to the documented caps.
 *
 * `totalExampleConversations` records how many example ids existed before the cap. It is *not* the
 * error's reach — the analyzer itself only collects a handful per chunk — so `affectedConversations`
 * remains the number to quote for impact.
 */
function toReportErrorGroup(group: RuntimeReport['errors'][number]): ShareReportErrorGroup {
  const { exampleConversationIds, sampleMessages, ...rest } = group;
  return {
    ...rest,
    exampleConversationIds: exampleConversationIds.slice(0, MAX_EXAMPLE_CONVERSATIONS),
    totalExampleConversations: exampleConversationIds.length,
    sampleMessages: sampleMessages.slice(0, MAX_SAMPLE_MESSAGES),
  };
}

/** Projects a runtime report into the report's sorted, capped form. */
export function toShareRuntime(report: RuntimeReport, analyzedOn?: string): ShareReportRuntime {
  return {
    schemaVersion: report.schemaVersion,
    analyzedOn,
    transcriptsAnalyzed: report.transcriptsAnalyzed,
    transcriptRowsAnalyzed: report.transcriptRowsAnalyzed,
    conversationsWithErrors: report.conversationsWithErrors,
    totalErrors: report.totalErrors,
    uniqueErrorTypes: report.uniqueErrorTypes,
    errorRatePercent: report.errorRatePercent,
    totalSteps: report.totalSteps,
    totalDurationMs: report.totalDurationMs,
    avgStepMs: report.avgStepMs,
    totalToolCalls: report.totalToolCalls,
    totalKnowledgeSearches: report.totalKnowledgeSearches,
    knowledgeTraces: report.knowledgeTraces,
    knowledgeTracesWithSearch: report.knowledgeTracesWithSearch,
    knowledgeSourcesConfigured: report.knowledgeSourcesConfigured,
    knowledgeSourcesCited: report.knowledgeSourcesCited,
    knowledgeSourcesNeverUsed: report.knowledgeSourcesNeverUsed,
    knowledgeSourcesOmitted: report.knowledgeSourcesOmitted,
    answersWithoutCitations: report.answersWithoutCitations,

    errors: [...report.errors].sort((a, b) => b.count - a.count).map(toReportErrorGroup),
    slowestNodes: [...report.nodes].sort((a, b) => b.avgMs - a.avgMs),
    // Most called first. Least-called is the same list read backwards, so storing a second array would
    // only create an opportunity for the two to disagree.
    tools: [...report.tools].sort((a, b) => b.calls - a.calls),
    // Most used to least used, ranked on citations first: a source that is constantly returned and
    // never read is not more used than one the answers actually rely on.
    knowledge: [...report.knowledge].sort(
      (a, b) => b.citedAnswers - a.citedAnswers || b.retrievedSearches - a.retrievedSearches,
    ),
  };
}

/**
 * Joins the configured inventory to what actually ran.
 *
 * `runtime` being undefined is not the same as a runtime report that saw nothing: the first means no
 * analysis exists, the second means one ran and found no activity. Both yield `not-attributable`, but
 * only the second is a statement about the agent.
 */
export function buildCapabilityUse(
  components: readonly ArtComponent[],
  runtime: RuntimeReport | undefined,
): CapabilityUseSummary {
  const designTools = components.filter((component) => component.kind === 'tool');
  const designKnowledge = components.filter((component) => component.kind === 'knowledge');

  const toolsByName = new Map(
    (runtime?.tools ?? []).map((tool) => [normalizeName(tool.name), tool] as const),
  );
  const knowledgeByName = new Map(
    (runtime?.knowledge ?? []).map((entry) => [normalizeName(entry.name), entry] as const),
  );

  // Absence only means something if the sample recorded activity of that kind at all.
  const toolActivityObserved = (runtime?.totalToolCalls ?? 0) > 0;
  const knowledgeActivityObserved = (runtime?.knowledgeTracesWithSearch ?? 0) > 0;

  const tools: CapabilityUse[] = designTools.map((component) => {
    const observed = toolsByName.get(normalizeName(component.name));
    if (observed) {
      return {
        kind: 'tool',
        name: component.name,
        subKind: component.subKind,
        state: 'observed',
        inDesignInventory: true,
        calls: observed.calls,
        conversationReach: observed.conversationReach,
        errorCount: observed.errorCount,
        avgMs: observed.avgMs,
        maxMs: observed.maxMs,
        citationRatePercent: null,
        neverCited: null,
        confidence: null,
        citedAnswers: null,
      };
    }
    return {
      kind: 'tool',
      name: component.name,
      subKind: component.subKind,
      state: toolActivityObserved ? 'not-observed' : 'not-attributable',
      inDesignInventory: true,
      // A tool the sample could never have attributed has an unknown call count, not zero.
      calls: toolActivityObserved ? 0 : null,
      conversationReach: toolActivityObserved ? 0 : null,
      errorCount: null,
      avgMs: null,
      maxMs: null,
      citationRatePercent: null,
      neverCited: null,
      confidence: null,
      citedAnswers: null,
    };
  });

  // Anything observed that ART did not inventory — connected-agent hops, platform tools. Without these
  // the per-tool call counts would not reconcile with `totalToolCalls`.
  const designToolNames = new Set(designTools.map((component) => normalizeName(component.name)));
  for (const observed of runtime?.tools ?? []) {
    if (designToolNames.has(normalizeName(observed.name))) continue;
    tools.push({
      kind: 'tool',
      name: observed.name,
      state: 'observed',
      inDesignInventory: false,
      calls: observed.calls,
      conversationReach: observed.conversationReach,
      errorCount: observed.errorCount,
      avgMs: observed.avgMs,
      maxMs: observed.maxMs,
      citationRatePercent: null,
      neverCited: null,
      confidence: null,
      citedAnswers: null,
    });
  }

  const knowledge: CapabilityUse[] = designKnowledge.map((component) => {
    const observed = knowledgeByName.get(normalizeName(component.name));
    if (observed) {
      return {
        kind: 'knowledge',
        name: component.name,
        subKind: component.subKind,
        state: 'observed',
        inDesignInventory: true,
        // Retrieval, not selection: a source is "used" as often as a search actually returned it.
        calls: observed.retrievedSearches,
        conversationReach: observed.conversationReach,
        errorCount: null,
        avgMs: observed.avgMs,
        maxMs: null,
        citationRatePercent: observed.citationRatePercent,
        neverCited: observed.citedAnswers === 0,
        confidence: observed.confidence,
        citedAnswers: observed.citedAnswers,
        exampleConversationIds:
          observed.citedConversationIds.length > 0
            ? observed.citedConversationIds
            : observed.exampleConversationIds,
      };
    }
    return {
      kind: 'knowledge',
      name: component.name,
      subKind: component.subKind,
      state: knowledgeActivityObserved ? 'not-observed' : 'not-attributable',
      inDesignInventory: true,
      calls: knowledgeActivityObserved ? 0 : null,
      conversationReach: knowledgeActivityObserved ? 0 : null,
      errorCount: null,
      avgMs: null,
      maxMs: null,
      citationRatePercent: null,
      neverCited: null,
      confidence: knowledgeActivityObserved ? 'NeverUsed' : null,
      citedAnswers: null,
    };
  });

  const designKnowledgeNames = new Set(
    designKnowledge.map((component) => normalizeName(component.name)),
  );
  for (const observed of runtime?.knowledge ?? []) {
    if (designKnowledgeNames.has(normalizeName(observed.name))) continue;
    knowledge.push({
      kind: 'knowledge',
      name: observed.name,
      state: 'observed',
      inDesignInventory: false,
      calls: observed.retrievedSearches,
      conversationReach: observed.conversationReach,
      errorCount: null,
      avgMs: observed.avgMs,
      maxMs: null,
      citationRatePercent: observed.citationRatePercent,
      neverCited: observed.citedAnswers === 0,
      confidence: observed.confidence,
      citedAnswers: observed.citedAnswers,
      exampleConversationIds:
        observed.citedConversationIds.length > 0
          ? observed.citedConversationIds
          : observed.exampleConversationIds,
    });
  }

  return {
    tools,
    knowledge,
    // Only ever lists capabilities whose absence was actually measurable.
    neverCalledTools: tools
      .filter((tool) => tool.state === 'not-observed')
      .map((tool) => tool.name),
    neverSearchedKnowledge: knowledge
      .filter((entry) => entry.state === 'not-observed' || entry.confidence === 'NeverUsed')
      .map((entry) => entry.name),
    // Retrieval with no citation, specifically. A source whose group was searched but which never came
    // back is a different problem and does not belong in this list.
    searchedButNeverCitedKnowledge: knowledge
      .filter((entry) => entry.confidence === 'RetrievedOnly')
      .map((entry) => entry.name),
    noObservedActivity: !toolActivityObserved && !knowledgeActivityObserved,
  };
}

function toAgent(
  botName: string,
  isRoot: boolean,
  artReview: ArtReview | undefined,
  job: RuntimeJob | undefined,
  botId?: string,
  unresolvedReason?: string,
  revisedScore?: number | null,
): ShareReportAgent {
  const runtime = job?.report ? toShareRuntime(job.report, job.createdOn) : undefined;

  return {
    botId,
    botName,
    isRoot,
    reviewed: Boolean(artReview),
    unresolvedReason,
    design: artReview
      ? {
          // Falls back to the rubric's verdict whenever this app holds no number of its own —
          // a snapshot saved before it wrote agent rows, or an agent whose review produced no
          // score. Reporting that as a zero would read as a measured failure.
          score: typeof revisedScore === 'number' ? revisedScore : artReview.score,
          reviewDate: artReview.reviewDate,
          sourceEnvironment: artReview.sourceEnvironment,
          counts: artReview.counts,
          pillars: artReview.pillars,
          findings: artReview.findings,
          components: artReview.components,
          instructionCoverage: artReview.instructionCoverage,
          coverage: artReview.coverage,
          coverageBasis: artReview.coverageBasis,
          coverageSets: artReview.coverageSets,
          orchestration: artReview.orchestration,
          scoreBasis: artReview.scoreBasis,
          skillReviewMode: artReview.skillReviewMode,
        }
      : undefined,
    runtime,
    // Needs a design inventory to join against; without one there is nothing to say about absence.
    capabilityUse: artReview ? buildCapabilityUse(artReview.components, job?.report) : undefined,
  };
}

/** Assembles the report. Deterministic given its input. */
export function buildShareReport(input: BuildShareReportInput): ShareReport {
  const { review, snapshot, aggregated, runtimeByAgent } = input;
  const generatedOn = (input.generatedOn ?? new Date()).toISOString();

  const agents = aggregated.agents.map((agent) =>
    toAgent(
      agent.botName,
      agent.isRoot,
      agent.review,
      agent.botId ? runtimeByAgent.get(agent.botId.toLowerCase()) : undefined,
      agent.botId,
      agent.unresolvedReason,
      agent.botId ? input.scoreByAgent?.get(agent.botId.toLowerCase()) : undefined,
    ),
  );

  const notes = [OBSERVED_USE_NOTE, CITATION_NOTE];
  if (snapshot.rulePackName === 'architecture-orchestration') {
    notes.push('Snapshot-bound evidence only. The architecture score is the mean of the agents reviewed in this snapshot; agents that could not be reviewed are excluded rather than scored zero. Per-agent runtime reports may overlap and must not be summed.');
    notes.push(`Orchestration status: ${input.orchestration?.status ?? 'not scheduled'}.`);
    for (const item of input.orchestration?.assessments ?? []) {
      notes.push(`${item.agentName} / ${item.stage}: ${item.status}${item.error ? ` - ${item.error}` : ''}`);
    }
    notes.push(...(input.orchestration?.gaps ?? []));
    if (input.orchestration?.error) notes.push(input.orchestration.error);
  }

  if (agents.some((agent) => (agent.runtime?.errors.length ?? 0) > 0)) {
    notes.push(
      `Example conversation ids are capped at ${MAX_EXAMPLE_CONVERSATIONS} per error type. `
        + 'totalExampleConversations is how many examples were collected, which is itself a sample. '
        + 'affectedConversations is the number of conversations the error actually reached.',
    );
  }

  if (snapshot.transcriptStart && snapshot.transcriptEnd) {
    notes.push(
      `Runtime figures cover ${snapshot.transcriptStart} to ${snapshot.transcriptEnd} only. `
        + 'Design findings describe configuration and are not limited to that window.',
    );
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    ...(input.orchestration ? { orchestration: input.orchestration } : {}),
    generatedOn,
    review: {
      id: review.id,
      projectName: review.projectName,
      assetType: review.assetType,
      ownerName: review.ownerName,
      environmentName: review.environmentName,
      environmentUrl: review.environmentUrl,
    },
    snapshot: {
      id: snapshot.id,
      sequenceNumber: snapshot.sequenceNumber,
      score: snapshot.score,
      grade: snapshot.grade,
      status: snapshot.status,
      runTimestamp: snapshot.runTimestamp,
      rulePackName: snapshot.rulePackName,
      rulePackVersion: snapshot.rulePackVersion,
      artifactFileName: snapshot.artifactFileName,
      artifactVersion: snapshot.artifactVersion,
      transcriptStart: snapshot.transcriptStart,
      transcriptEnd: snapshot.transcriptEnd,
    },
    rollup: {
      rolledUpScore: aggregated.rolledUpScore,
      reviewedCount: aggregated.reviewedCount,
      totalCount: aggregated.totalCount,
    },
    agents,
    notes,
  };
}

/** Filename stem shared by both exports, so the pair is obviously a pair. */
export function reportFileStem(report: ShareReport): string {
  const safe = report.review.projectName.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '');
  return `${safe || 'agent-review'}-snapshot-${report.snapshot.sequenceNumber}`;
}
