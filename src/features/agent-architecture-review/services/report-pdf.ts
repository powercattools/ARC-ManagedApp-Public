/**
 * Renders a `ShareReport` to PDF.
 *
 * This module never reads Dataverse, ART or the runtime analyzer — it takes the already-built report
 * and draws it. That is deliberate: the JSON export and the PDF are then guaranteed to describe the
 * same run, and anything added to the report shows up in both without a second code path.
 *
 * jsPDF is used at 4.x rather than the 2.5.2 the Agent Review Tool pins, because 2.x carries unpatched
 * critical advisories. Only core text and vector drawing is used, which is unchanged between them.
 */

import { jsPDF } from 'jspdf';
import {
  type CapabilityUse,
  type ShareReport,
  type ShareReportAgent,
} from '../models/report';
import { KNOWLEDGE_CONFIDENCE_LABEL } from '../models/runtime';

const MARGIN = 16;
const PAGE_BOTTOM = 280;
const LINE = 4.4;

const BLUE = '#0078d4';
const GREEN = '#107c10';
const AMBER = '#b7580a';
const RED = '#c50f1f';
const TEXT_DARK = '#201f1e';
const TEXT_MID = '#605e5c';
const RULE = '#e1dfdd';

/** How many rows of each ranked table reach the PDF. The JSON carries them all. */
const TOP_N = 8;

function scoreColor(score: number): string {
  if (score >= 80) return GREEN;
  if (score >= 60) return AMBER;
  return RED;
}

function severityColor(severity: string): string {
  if (severity === 'error') return RED;
  if (severity === 'warning') return AMBER;
  return TEXT_MID;
}

/** ms → a duration a person can compare at a glance. */
function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60_000).toFixed(1)} min`;
}

function dateOnly(iso?: string): string {
  if (!iso) return '-';
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? iso : parsed.toLocaleDateString();
}

/**
 * Cursor over the document.
 *
 * Wrapping jsPDF's implicit y-position keeps every section from re-implementing page breaks, which is
 * where hand-rolled PDF layouts usually go wrong — a section that forgets to check overflows silently
 * off the bottom of the page rather than failing.
 */
class Layout {
  readonly doc: jsPDF;
  readonly contentWidth: number;
  y = 20;

  constructor() {
    this.doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    this.contentWidth = this.doc.internal.pageSize.getWidth() - MARGIN * 2;
  }

  get pageWidth(): number {
    return this.doc.internal.pageSize.getWidth();
  }

  /** Starts a new page if `needed` mm would not fit. */
  need(needed = LINE * 2): void {
    if (this.y + needed > PAGE_BOTTOM) {
      this.doc.addPage();
      this.y = 20;
    }
  }

  gap(mm: number): void {
    this.y += mm;
  }

  text(value: string, options: { size?: number; bold?: boolean; color?: string; indent?: number } = {}): void {
    const { size = 9, bold = false, color = TEXT_DARK, indent = 0 } = options;
    this.doc.setFontSize(size);
    this.doc.setFont('helvetica', bold ? 'bold' : 'normal');
    this.doc.setTextColor(color);

    const lines = this.doc.splitTextToSize(value, this.contentWidth - indent) as string[];
    for (const line of lines) {
      this.need(LINE);
      this.doc.text(line, MARGIN + indent, this.y);
      this.y += LINE;
    }
  }

  /** A labelled section rule. */
  heading(value: string, size = 12): void {
    this.need(14);
    this.gap(3);
    this.doc.setFontSize(size);
    this.doc.setFont('helvetica', 'bold');
    this.doc.setTextColor(TEXT_DARK);
    this.doc.text(value, MARGIN, this.y);
    this.y += 2.5;
    this.doc.setDrawColor(RULE);
    this.doc.line(MARGIN, this.y, this.pageWidth - MARGIN, this.y);
    this.y += 5;
  }

  /** Draws page numbers last, when the total is finally known. */
  finish(title: string): Blob {
    const total = this.doc.getNumberOfPages();
    for (let page = 1; page <= total; page += 1) {
      this.doc.setPage(page);
      this.doc.setFontSize(7.5);
      this.doc.setFont('helvetica', 'normal');
      this.doc.setTextColor(TEXT_MID);
      this.doc.text(`${title} · Page ${page} of ${total}`, MARGIN, 289);
    }
    return this.doc.output('blob');
  }
}

function renderCover(layout: Layout, report: ShareReport): void {
  const { review, snapshot, rollup } = report;

  layout.doc.setFillColor(BLUE);
  layout.doc.rect(0, 0, layout.pageWidth, 24, 'F');
  layout.doc.setTextColor('#ffffff');
  layout.doc.setFontSize(15);
  layout.doc.setFont('helvetica', 'bold');
  layout.doc.text('Agent Review Center', MARGIN, 15);
  layout.y = 34;

  layout.text(review.projectName, { size: 17, bold: true });
  layout.gap(2);

  layout.text(`Snapshot #${snapshot.sequenceNumber}`, { size: 10, color: TEXT_MID });
  layout.text(`Environment: ${review.environmentName ?? review.environmentUrl ?? '-'}`, { color: TEXT_MID });
  layout.text(`Owner: ${review.ownerName}`, { color: TEXT_MID });
  layout.text(`Rule pack: ${snapshot.rulePackName} ${snapshot.rulePackVersion}`, { color: TEXT_MID });
  layout.text(`Snapshot taken: ${dateOnly(snapshot.runTimestamp)}`, { color: TEXT_MID });
  layout.text(`Report generated: ${dateOnly(report.generatedOn)}`, { color: TEXT_MID });

  layout.gap(4);
  layout.text(snapshot.score === null ? 'Architecture score unavailable - no blended score' : `Grade ${snapshot.grade ?? 'unavailable'} · Score ${snapshot.score}/100`, {
    size: 13,
    bold: true,
    color: snapshot.score === null ? TEXT_MID : scoreColor(snapshot.score),
  });

  if (rollup.rolledUpScore !== null && rollup.totalCount > 1) {
    layout.text(
      `Rolled up across ${rollup.reviewedCount} of ${rollup.totalCount} agents: ${rollup.rolledUpScore}/100`,
      { color: TEXT_MID },
    );
  }

  // The window has to sit on the cover: every runtime number below is scoped to it, and a reader who
  // misses that will read "not observed" as "unused".
  layout.gap(3);
  if (snapshot.transcriptStart && snapshot.transcriptEnd) {
    layout.text(
      `Runtime analysis window: ${dateOnly(snapshot.transcriptStart)} to ${dateOnly(snapshot.transcriptEnd)}`,
      { bold: true },
    );
  } else {
    layout.text('Runtime analysis window: not recorded for this snapshot', { color: TEXT_MID });
  }
}

function renderPillars(layout: Layout, agent: ShareReportAgent): void {
  const pillars = agent.design?.pillars ?? [];
  if (pillars.length === 0) return;

  layout.heading('Score by pillar', 11);
  for (const pillar of pillars) {
    layout.need(LINE);
    const scored = pillar.applicable && pillar.score !== null;
    const label = scored ? `${pillar.score}/100` : 'Not assessed';
    const suffix = pillar.complete ? '' : ' (incomplete)';
    layout.text(`${pillar.name} · Weight ${pillar.weight}% · ${label}${suffix}`, {
      color: scored ? scoreColor(pillar.score ?? 0) : TEXT_MID,
    });
  }
}

/**
 * The five instruction elements the classifier looks for.
 *
 * Rendered only when the classifier actually completed. A review where it never ran carries no
 * missing-element findings, which would draw as five ticks — a clean bill of health from a check that
 * did not happen — so the unevaluated case prints the reason instead of the grid.
 */
function renderInstructionCoverage(layout: Layout, agent: ShareReportAgent): void {
  const coverage = agent.design?.instructionCoverage;
  if (!coverage) return;

  layout.heading('Instruction coverage', 11);
  layout.text(`AI classifier: ${coverage.label}`, { color: coverage.evaluated ? TEXT_MID : AMBER });

  if (!coverage.evaluated) {
    layout.text(
      coverage.reason
        ?? 'The instruction elements were not assessed, so nothing here should be read as a pass.',
      { color: AMBER, indent: 3 },
    );
    return;
  }

  for (const element of coverage.elements) {
    layout.need(LINE);
    layout.text(`${element.present ? '[present]' : '[missing]'} ${element.label}`, {
      indent: 3,
      color: element.present ? GREEN : AMBER,
    });
  }
}

/**
 * Which configured capabilities the evaluation sets actually exercise.
 *
 * `coverageBasis` is printed with the table rather than tucked into a footnote: under `inferred`, ART
 * matched cases to capabilities by name, so a zero means "no case names it" and not necessarily "no
 * case exercises it". Presenting the counts without that qualifier would overstate them.
 */
function renderEvaluationCoverage(layout: Layout, agent: ShareReportAgent): void {
  const design = agent.design;
  if (!design) return;
  if (design.coverage.length === 0 && design.coverageSets.length === 0) return;

  layout.heading('Evaluation coverage', 11);
  layout.text(
    design.coverageBasis === 'declared'
      ? 'Cases declare the capability they exercise, so a zero below is a real gap.'
      : 'Cases were matched to capabilities by name, so a zero below can mean "not exercised" or '
        + '"could not be determined".',
    { color: TEXT_MID },
  );
  layout.gap(1.5);

  if (design.coverageSets.length > 0) {
    layout.text('Evaluation sets', { bold: true });
    for (const set of design.coverageSets) {
      layout.need(LINE);
      const percent = set.total > 0 ? Math.round((set.covered / set.total) * 100) : 0;
      layout.text(
        `${set.name} · ${set.covered}/${set.total} capabilities (${percent}%) · ${set.caseCount} cases · `
          + `${set.declaringCases} declaring`,
        { indent: 3, color: set.covered === 0 ? AMBER : TEXT_DARK },
      );
    }
    layout.gap(1.5);
  }

  if (design.coverage.length > 0) {
    layout.text('Capabilities', { bold: true });
    for (const row of design.coverage) {
      layout.need(LINE);
      layout.text(`${row.name} [${row.kind}] · ${row.cases} cases`, {
        indent: 3,
        color: row.cases === 0 ? AMBER : TEXT_DARK,
      });
    }
  }
}

/**
 * Findings about how skills interact.
 *
 * These are agent-level by construction — no single skill owns them — so they appear nowhere in the
 * per-skill findings list and would be dropped entirely if this section did not exist.
 */
function renderOrchestration(layout: Layout, agent: ShareReportAgent): void {
  const orchestration = agent.design?.orchestration;
  if (!orchestration) return;

  layout.heading(`Cross-skill orchestration (${orchestration.findings.length})`, 11);
  if (orchestration.summary) layout.text(orchestration.summary, { color: TEXT_MID });

  if (orchestration.findings.length === 0) {
    layout.text(
      orchestration.status === 'complete'
        ? 'No cross-skill issues found.'
        : `Not evaluated (status "${orchestration.status}").`,
      { color: orchestration.status === 'complete' ? TEXT_MID : AMBER },
    );
    return;
  }

  for (const finding of orchestration.findings) {
    layout.need(LINE * 4);
    layout.text(`[${finding.severity.toUpperCase()}] ${finding.ruleId} · ${finding.title}`, {
      bold: true,
      color: severityColor(finding.severity),
    });
    if (finding.skills.length > 0) layout.text(`Skills: ${finding.skills.join(', ')}`, { indent: 3 });
    if (finding.evidence) layout.text(`Evidence: ${finding.evidence}`, { indent: 3 });
    if (finding.rationale) layout.text(`Impact: ${finding.rationale}`, { indent: 3 });
    if (finding.recommendation) layout.text(`Fix: ${finding.recommendation}`, { indent: 3 });
    layout.gap(1.5);
  }
}

function renderFindings(layout: Layout, agent: ShareReportAgent): void {
  const findings = agent.design?.findings ?? [];
  layout.heading(`Findings (${findings.length})`, 11);

  if (findings.length === 0) {
    layout.text('No findings recorded.', { color: TEXT_MID });
    return;
  }

  for (const finding of findings) {
    layout.need(LINE * 4);
    layout.text(`[${finding.severity.toUpperCase()}] ${finding.id} · ${finding.title}`, {
      bold: true,
      color: severityColor(finding.severity),
    });
    if (finding.fact) layout.text(`Observed: ${finding.fact}`, { indent: 3 });
    if (finding.why) layout.text(`Impact: ${finding.why}`, { indent: 3 });
    if (finding.fix) layout.text(`Fix: ${finding.fix}`, { indent: 3 });
    layout.gap(1.5);
  }
}

function describeUse(entry: CapabilityUse): string {
  if (entry.state === 'not-attributable') return 'Not attributable. Transcripts do not name it';
  if (entry.state === 'not-observed') return 'Not observed in the window';

  const parts = [`${entry.calls ?? 0} calls`];
  if (entry.conversationReach !== null) parts.push(`${entry.conversationReach} conversations`);
  if (entry.avgMs !== null) parts.push(`avg ${duration(entry.avgMs)}`);
  if (entry.errorCount) parts.push(`${entry.errorCount} errors`);
  if (entry.citationRatePercent !== null) parts.push(`cited ${entry.citationRatePercent.toFixed(1)}%`);
  else if (entry.kind === 'knowledge') parts.push('citations unknown');
  return parts.join(' · ');
}

function renderCapabilityUse(layout: Layout, agent: ShareReportAgent): void {
  const use = agent.capabilityUse;
  if (!use) return;

  layout.heading('Configured capabilities and observed use', 11);

  if (use.noObservedActivity) {
    layout.text(
      'The runtime analysis recorded no tool or knowledge activity in this window, so nothing below '
        + 'can be read as evidence that a capability is unused.',
      { color: AMBER },
    );
    layout.gap(1.5);
  }

  const section = (title: string, entries: CapabilityUse[]) => {
    if (entries.length === 0) return;
    layout.need(LINE * 2);
    layout.text(title, { bold: true });
    for (const entry of entries) {
      layout.need(LINE);
      const origin = entry.inDesignInventory ? '' : ' (not in inventory)';
      const type = entry.subKind ? ` [${entry.subKind}]` : '';
      layout.text(`${entry.name}${type}${origin} · ${describeUse(entry)}`, { indent: 3 });
    }
    layout.gap(1.5);
  };

  section('Tools', use.tools);
  section('Knowledge', use.knowledge);

  if (use.neverCalledTools.length > 0) {
    layout.text(`Configured but never called: ${use.neverCalledTools.join(', ')}`, { color: AMBER });
  }
  if (use.neverSearchedKnowledge.length > 0) {
    layout.text(`Configured but never searched: ${use.neverSearchedKnowledge.join(', ')}`, { color: AMBER });
  }
  if (use.searchedButNeverCitedKnowledge.length > 0) {
    layout.text(
      `Searched but never cited: ${use.searchedButNeverCitedKnowledge.join(', ')}. Retrieval cost with `
        + 'no demonstrated benefit.',
      { color: AMBER },
    );
  }
}

function renderRuntime(layout: Layout, agent: ShareReportAgent): void {
  const runtime = agent.runtime;

  layout.heading('Runtime analysis', 11);
  if (!runtime) {
    layout.text('No completed runtime analysis for this agent under this snapshot.', { color: TEXT_MID });
    return;
  }

  layout.text(
    `${runtime.transcriptsAnalyzed} conversations analysed · ${runtime.totalErrors} errors across `
      + `${runtime.uniqueErrorTypes} types · ${runtime.errorRatePercent.toFixed(1)}% of conversations hit an error`,
  );
  layout.text(
    `${runtime.totalSteps} steps · total ${duration(runtime.totalDurationMs)} · average step `
      + `${duration(runtime.avgStepMs)} · ${runtime.totalToolCalls} tool calls · `
      + `${runtime.totalKnowledgeSearches} knowledge searches`,
    { color: TEXT_MID },
  );

  // -- Errors --
  layout.gap(2);
  layout.text(`Top errors (${Math.min(runtime.errors.length, TOP_N)} of ${runtime.errors.length})`, {
    bold: true,
  });
  if (runtime.errors.length === 0) {
    layout.text('No errors recorded in this window.', { color: TEXT_MID, indent: 3 });
  }
  for (const error of runtime.errors.slice(0, TOP_N)) {
    layout.need(LINE * 4);
    layout.text(
      `${error.type} · ${error.count} occurrences in ${error.affectedConversations} conversations `
        + `(${error.percentOfErrors.toFixed(1)}% of errors)`,
      { bold: true, color: RED, indent: 3 },
    );
    if (error.failedComponent) layout.text(`Component: ${error.failedComponent}`, { indent: 6 });
    layout.text(`Root cause: ${error.rootCause}`, { indent: 6 });
    layout.text(`Recommendation: ${error.recommendation}`, { indent: 6 });
    if (error.exampleConversationIds.length > 0) {
      layout.text(
        `Example conversations (${error.exampleConversationIds.length} of `
          + `${error.totalExampleConversations}): ${error.exampleConversationIds.join(', ')}`,
        { indent: 6, color: TEXT_MID },
      );
    }
    layout.gap(1.5);
  }

  // -- Latency --
  layout.gap(1.5);
  layout.text('Slowest components', { bold: true });
  if (runtime.slowestNodes.length === 0) {
    layout.text('No step timings recorded.', { color: TEXT_MID, indent: 3 });
  }
  for (const node of runtime.slowestNodes.slice(0, TOP_N)) {
    layout.need(LINE);
    layout.text(
      `${node.name} [${node.kind}] · avg ${duration(node.avgMs)} · max ${duration(node.maxMs)} · `
        + `${node.calls} calls · ${node.percentOfTime.toFixed(1)}% of total time`,
      { indent: 3 },
    );
  }

  // -- Tool usage, most to least --
  layout.gap(1.5);
  layout.text('Tool usage, most to least called', { bold: true });
  if (runtime.tools.length === 0) {
    layout.text('No tool calls recorded.', { color: TEXT_MID, indent: 3 });
  }
  for (const tool of runtime.tools.slice(0, TOP_N)) {
    layout.need(LINE);
    layout.text(
      `${tool.name} [${tool.kind}] · ${tool.calls} calls (${tool.percentOfCalls.toFixed(1)}%) · `
        + `${tool.conversationReach} conversations · avg ${duration(tool.avgMs)}`
        + (tool.errorCount ? ` · ${tool.errorCount} errors` : ''),
      { indent: 3 },
    );
  }

  // -- Knowledge --
  layout.gap(1.5);
  layout.text('Knowledge usage, most to least used', { bold: true });
  layout.text(
    `${runtime.knowledgeSourcesConfigured} configured · ${runtime.knowledgeSourcesCited} cited · `
      + `${runtime.knowledgeSourcesNeverUsed} never used · `
      + `${runtime.answersWithoutCitations} answers cited nothing`,
    { color: TEXT_MID, indent: 3 },
  );
  if (runtime.knowledge.length === 0) {
    layout.text('No knowledge searches recorded.', { color: TEXT_MID, indent: 3 });
  }
  for (const source of runtime.knowledge.slice(0, TOP_N)) {
    layout.need(LINE);
    // Retrieval and citation are reported separately and never merged into one "usage" number: being
    // returned by a search is not evidence that an answer used the source.
    layout.text(
      `${source.name} · ${KNOWLEDGE_CONFIDENCE_LABEL[source.confidence]} · `
        + `${source.retrievedSearches} retrieved · ${source.citedAnswers} cited `
        + `(${source.citationRatePercent.toFixed(0)}%) · ${source.conversationReach} conversations`,
      { indent: 3 },
    );
    // An aggregate row stands for many one-off results, so name the domains behind it. That is the part
    // an owner can act on: a domain answering repeatedly is a candidate for a real knowledge source.
    const sites = Object.entries(source.sites ?? {}).sort((a, b) => b[1] - a[1]);
    if (sites.length > 0) {
      layout.need(LINE);
      layout.text(
        `${source.pagesReturned} results across ${sites.length} sites · `
          + sites.slice(0, 5).map(([site, count]) => `${site} (${count})`).join(', '),
        { color: TEXT_MID, indent: 5 },
      );
    }
  }
  if (runtime.knowledgeSourcesOmitted > 0) {
    layout.text(`+ ${runtime.knowledgeSourcesOmitted} further sources not listed.`, {
      color: TEXT_MID,
      indent: 3,
    });
  }
}

function renderAgent(layout: Layout, agent: ShareReportAgent, index: number): void {
  layout.doc.addPage();
  layout.y = 20;

  const role = agent.isRoot ? 'Reviewed agent' : 'Connected agent';
  layout.text(`${index}. ${agent.botName}`, { size: 14, bold: true });
  layout.text(role, { color: TEXT_MID });

  if (!agent.reviewed) {
    layout.gap(2);
    layout.text(
      agent.unresolvedReason
        ? `Not reviewed: ${agent.unresolvedReason}`
        : 'This agent has not been reviewed, so it contributes no score.',
      { color: AMBER },
    );
  } else if (agent.design) {
    layout.gap(1.5);
    // A withheld score has no number and no band. `0/100` would print as a measured
    // failure, which is the opposite claim to "nothing could be measured".
    layout.text(
      agent.design.score === null ? 'Score not assessed' : `Score ${agent.design.score}/100`,
      {
        size: 12,
        bold: true,
        color: agent.design.score === null ? AMBER : scoreColor(agent.design.score),
      },
    );
    layout.text(agent.design.scoreBasis.label, {
      color: agent.design.scoreBasis.version === undefined
        || agent.design.scoreBasis.status === 'partial'
        ? AMBER
        : TEXT_MID,
    });
    layout.text(
      `${agent.design.counts.passed} passed · ${agent.design.counts.warnings} warnings · `
        + `${agent.design.counts.errors} errors · ${agent.design.counts.evaluated} rules evaluated`,
      { color: TEXT_MID },
    );
    // A standard review never opened the skills' resources, so its clean result covers less ground.
    if (agent.design.skillReviewMode === 'standard') {
      layout.text(
        'Limited coverage. Per-resource skill analysis was not available for this review.',
        { color: AMBER },
      );
    }
  }

  if (agent.reviewed) {
    renderPillars(layout, agent);
    renderInstructionCoverage(layout, agent);
    renderFindings(layout, agent);
    renderOrchestration(layout, agent);
    renderEvaluationCoverage(layout, agent);
    renderCapabilityUse(layout, agent);
  }
  renderRuntime(layout, agent);
}

function renderNotes(layout: Layout, report: ShareReport): void {
  if (report.notes.length === 0) return;
  layout.doc.addPage();
  layout.y = 20;
  layout.heading('How to read this report', 12);
  for (const note of report.notes) {
    layout.text(`• ${note}`);
    layout.gap(1.5);
  }
}

/** Renders the report. Returns a PDF blob ready to download. */
export function renderReportPdf(report: ShareReport): Blob {
  const layout = new Layout();

  renderCover(layout, report);
  report.agents.forEach((agent, index) => renderAgent(layout, agent, index + 1));
  renderNotes(layout, report);

  return layout.finish(`${report.review.projectName} · Snapshot #${report.snapshot.sequenceNumber}`);
}
