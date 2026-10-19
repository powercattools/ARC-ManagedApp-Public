/**
 * A declarative agent's stored review, projected onto the shared findings list.
 *
 * Nothing here judges the agent. Every verdict, every weight and every word of explanation is read
 * back from the record the Agent Review Tool wrote; this file only reshapes that record into the
 * two inputs {@link buildConsolidatedView} already understands, so a declarative agent lands in the
 * same list, with the same buckets, filters and drawer, as every other subject in this app.
 *
 * It lives beside the panel rather than in `engine/` for the reason given in `ruleMetaLookup.ts`:
 * `@review-ui` is a React barrel, and the engine stays free of anything only the renderer needs.
 *
 * A declarative agent's review carries four populations, and they are not interchangeable:
 *
 *  1. `packageValidation.findings` — deterministic manifest rules, each with its own id.
 *  2. `evaluation.<name>Criterion.issues` — what the model judged to be wrong.
 *  3. `…passingChecks` — what it judged to be right. These have no rule id and no title at all.
 *  4. `…assessmentNotes` — criteria it declined to judge, and why.
 *
 * `manifestHealth` is deliberately **not** rendered. It is the raw signal the deterministic rules
 * are derived from — `versionSupported.pass === false` is the same fact as `DA-VERSION-SUPPORTED:
 * Fail` — so showing both would count every manifest check twice.
 */

// Reached by its own module path rather than through `@review-ui`, which is a React barrel: this
// file is pure data and nothing in it renders, so pulling the component index in would make every
// consumer — and every test — depend on React and the Fluent icon set for no benefit.
import {
  buildConsolidatedView,
  type ConsolidatedView,
  type FindingInput,
  type RuleMeta,
  type RuleMetaLookup,
  type RuleOutcomeInput,
} from '@review-ui/consolidatedFindings';

import {
  buildDAScoreBreakdown,
  distinctGuidanceLinks,
  issueGuidanceLink,
  splitRecommendation,
  type CriterionResult,
  type DAEvaluationResult,
  type DAPackageFinding,
  type DAStoredReviewData,
  type EvaluationStatus,
  type IssueSeverity,
} from '../engine/scoring/art-ports';

/** The family every deterministic manifest rule reports under. */
const PACKAGE_FAMILY = 'Package validation';

export interface DAFindingsView {
  /** The rows, already bucketed, grouped and totalled by the shared builder. */
  view: ConsolidatedView;
  /**
   * Static facts for a rule id.
   *
   * Carries the real weight for declarative agents. A passing rule produces no finding — and for a
   * declarative agent it has no registry entry either — so without this a reader who opens a passed
   * row would see a title and nothing else.
   */
  ruleMeta: RuleMetaLookup;
  /**
   * Resolves a citation label back to its address.
   *
   * The shared drawer cites rules by an id it looks up in ART's curated reference table. A
   * declarative-agent finding instead carries a Learn URL outright, which that table has never
   * heard of. `resolveReference` falls back to showing the id verbatim, and the drawer prefers
   * whatever this function returns over the table's address — so the citation is stored under its
   * readable label and the address is handed back here.
   */
  referenceUrl: (referenceId: string) => string | undefined;
}

/**
 * A rule id turned into a heading.
 *
 * The manifest rules carry an id and an explanation and nothing else — ART has no title table for
 * them, because its own declarative-agent screen groups by criterion and never shows a per-rule
 * heading. Deriving the words from the id is therefore the only option that cannot drift: a rule
 * added to ART tomorrow gets a sensible heading here without anyone editing a list.
 */
function daRuleTitle(ruleId: string): string {
  const words = ruleId.replace(/^DA-/i, '').replace(/[-_]+/g, ' ').trim().toLowerCase();
  if (!words) return ruleId;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Severity to row status.
 *
 * There is no `info` here on purpose. `info` files a row under *Agent info*, which is for facts
 * worth knowing rather than things to act on, and every issue in this payload is a gap the maker is
 * being asked to close. A low-severity gap is still a gap, so the floor is "needs attention".
 */
function statusForSeverity(severity: IssueSeverity | undefined): 'error' | 'warning' {
  return severity === 'High' ? 'error' : 'warning';
}

/** A deterministic manifest finding's verdict, as a row status. */
function statusForPackageFinding(finding: DAPackageFinding): RuleOutcomeInput['status'] {
  if (finding.status === 'Pass') return 'passed';
  if (finding.status === 'Fail') return statusForSeverity(finding.severity);
  if (finding.status === 'N/A') return 'not-applicable';
  // Anything else is a rule the review reached but could not judge. `failed` is the stored word for
  // exactly that, and the shared list renders it as "Not assessed" — never as "Could not run",
  // which is reserved for the review itself breaking.
  return 'failed';
}

/** A criterion's own verdict, as a row status, for a criterion that reported nothing itemised. */
function statusForCriterion(status: EvaluationStatus): RuleOutcomeInput['status'] {
  if (status === 'Pass') return 'passed';
  if (status === 'Fail') return 'error';
  if (status === 'Warning') return 'warning';
  if (status === 'N/A') return 'not-applicable';
  return 'failed';
}

/** A stable, readable rule id for a criterion that reports something with no id of its own. */
function criterionRuleId(key: string): string {
  return `DA-${key.replace(/Criterion$/, '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toUpperCase()}`;
}

const evidenceKey = (sourceFile?: string, jsonPath?: string): string =>
  `${sourceFile ?? ''}#${jsonPath ?? ''}`;

/** The action and its example as one block; the verification step is a separate field on the row. */
function fixText(recommendation: string | undefined): { fix?: string; acceptanceCheck?: string } {
  if (!recommendation) return {};
  const parts = splitRecommendation(recommendation);
  const fix = [parts.action, parts.example].filter(Boolean).join('\n\n');
  return {
    ...(fix ? { fix } : {}),
    ...(parts.verify ? { acceptanceCheck: parts.verify } : {}),
  };
}

/**
 * Build the findings view for a stored declarative-agent review.
 *
 * The one rule that governs every line below: **a row that passed carries no finding.** The shared
 * builder merges a finding's severity into the outcome and takes the worse of the two, so attaching
 * even an informational note to a passing rule would move it out of Pass and into Agent info. A
 * passing rule's prose therefore goes to {@link DAFindingsView.ruleMeta}, which the drawer reads
 * precisely because a pass has nothing else to show.
 */
export function buildDAFindingsView(data: DAStoredReviewData): DAFindingsView {
  const outcomes: RuleOutcomeInput[] = [];
  const findings: FindingInput[] = [];
  const meta = new Map<string, RuleMeta>();
  const urlByLabel = new Map<string, string>();

  // Evidence is addressed by the file and path it was read from, which is how a finding points at
  // it. Used only to fill a fact the finding did not state itself.
  const evidenceByPath = new Map<string, string>();
  for (const record of data.evidence ?? []) {
    const key = evidenceKey(record.sourceFile, record.jsonPath);
    if (record.content && !evidenceByPath.has(key)) evidenceByPath.set(key, record.content);
  }

  /** Registers a citation under its readable label and returns that label, or nothing. */
  const cite = (url: string | undefined, label?: string): string | undefined => {
    const [link] = distinctGuidanceLinks([url ? { url, ...(label ? { label } : {}) } : undefined]);
    if (!link) return undefined;
    if (!urlByLabel.has(link.label)) urlByLabel.set(link.label, link.url);
    return link.label;
  };

  for (const finding of data.packageValidation?.findings ?? []) {
    const status = statusForPackageFinding(finding);
    const title = daRuleTitle(finding.ruleId);
    const reference = cite(finding.guidanceUrl);

    meta.set(finding.ruleId, {
      ...(finding.explanation ? { description: finding.explanation } : {}),
      ...(reference ? { references: [reference] } : {}),
      ...(finding.severity ? { severity: finding.severity } : {}),
    });

    outcomes.push({
      key: finding.ruleId,
      ruleId: finding.ruleId,
      family: PACKAGE_FAMILY,
      status,
      title,
      // Only read for a row that could not be scored, which is exactly where the explanation is the
      // whole answer: it says why the rule did not apply.
      ...(status === 'not-applicable' || status === 'failed'
        ? { note: finding.explanation }
        : {}),
    });

    if (status !== 'error' && status !== 'warning') continue;

    const fact = finding.evidence ?? evidenceByPath.get(evidenceKey(finding.sourceFile, finding.jsonPath));
    findings.push({
      id: finding.ruleId,
      family: PACKAGE_FAMILY,
      severity: status,
      title,
      ai: false,
      ...(fact ? { fact } : {}),
      ...(finding.explanation ? { why: finding.explanation } : {}),
      ...fixText(finding.recommendation),
      ...(finding.jsonPath ? { fieldPath: finding.jsonPath } : {}),
      ...(reference ? { referenceId: reference } : {}),
    });
  }

  // An absent evaluation still has six criteria to account for: the breakdown reads each one as
  // "Not assessed" rather than dropping it, which is the honest rendering of a review whose AI
  // stage never produced anything.
  const evaluation: DAEvaluationResult = data.evaluation ?? ({} as DAEvaluationResult);

  for (const part of buildDAScoreBreakdown(evaluation)) {
    const criterion = evaluation[part.key] as CriterionResult | null | undefined;
    const before = outcomes.length;

    criterion?.issues?.forEach((issue, index) => {
      const status = statusForSeverity(issue.severity);
      const ruleId = issue.ruleId || `${criterionRuleId(part.key)}-ISSUE`;
      const reference = cite(issueGuidanceLink(issue)?.url, issueGuidanceLink(issue)?.label);
      const fact = issue.evidence ?? evidenceByPath.get(evidenceKey(issue.sourceFile, issue.jsonPath));

      outcomes.push({
        key: `${part.key}:issue:${index}`,
        ruleId,
        family: part.label,
        status,
        title: part.label,
      });

      findings.push({
        id: ruleId,
        family: part.label,
        severity: status,
        // The criterion is the heading. An issue carries a long narrative description and no title
        // of its own, and the first sentence of a paragraph does not make an honest heading.
        title: part.label,
        ai: issue.method !== 'deterministic',
        ...(fact ? { fact } : {}),
        ...(issue.description ? { why: issue.description } : {}),
        ...fixText(issue.recommendation),
        ...(issue.jsonPath ? { fieldPath: issue.jsonPath } : {}),
        ...(reference ? { referenceId: reference } : {}),
      });
    });

    // Every passing check for one criterion is one row: they share a rule id and a verdict, so the
    // shared builder groups them, and their prose is joined into the one description the drawer
    // shows for that row.
    const passing = criterion?.passingChecks ?? [];
    if (passing.length) {
      const ruleId = criterionRuleId(part.key);
      const references = distinctGuidanceLinks(passing.map(check => ({ url: check.learnUrl })))
        .map(link => cite(link.url, link.label))
        .filter((label): label is string => !!label);

      meta.set(ruleId, {
        description: passing.map(check => check.description).filter(Boolean).join('\n\n'),
        ...(references.length ? { references } : {}),
      });

      passing.forEach((_check, index) => {
        outcomes.push({
          key: `${part.key}:pass:${index}`,
          ruleId,
          family: part.label,
          status: 'passed',
          title: part.label,
        });
      });
    }

    criterion?.assessmentNotes?.forEach((note, index) => {
      const ruleId = `${criterionRuleId(part.key)}-NOT-ASSESSED`;
      const reference = cite(note.learnUrl);
      meta.set(ruleId, {
        ...(note.description ? { description: note.description } : {}),
        ...(reference ? { references: [reference] } : {}),
      });
      outcomes.push({
        key: `${part.key}:not-assessed:${index}`,
        ruleId,
        family: part.label,
        status: note.status === 'N/A' ? 'not-applicable' : 'failed',
        title: part.label,
        note: note.description,
      });
    });

    // A criterion that itemised nothing still has a verdict, and dropping it would quietly shorten
    // the rubric from six parts to however many happened to report detail.
    if (outcomes.length === before) {
      outcomes.push({
        key: `${part.key}:status`,
        ruleId: criterionRuleId(part.key),
        family: part.label,
        status: statusForCriterion(part.status),
        title: part.label,
        ...(part.score === null
          ? { note: 'This criterion was not assessed, so its weight was removed from the score.' }
          : {}),
      });
    }
  }

  return {
    // Never `undefined`: that is the saved-before-outcomes signal, and it would make the list claim
    // it has no record of this review at all.
    view: buildConsolidatedView(outcomes, findings, undefined, {}),
    ruleMeta: (ruleId: string) => meta.get(ruleId),
    referenceUrl: (referenceId: string) => urlByLabel.get(referenceId),
  };
}
