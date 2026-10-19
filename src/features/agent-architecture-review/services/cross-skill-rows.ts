/**
 * Cross-skill orchestration findings, projected into the one findings list.
 *
 * These findings are agent-level by construction — no single skill owns a contradiction between
 * two of them — so ART returns them on their own `orchestration` field instead of in `findings`.
 * Nothing on this screen read that field: the PDF export was its only consumer, and its own comment
 * says they "would be dropped entirely if this section did not exist". On screen they were.
 *
 * Projecting them needs both halves, because the consolidated list is built from rule *outcomes*
 * and only attaches findings to a row that already exists. A finding whose rule contributed no
 * outcome has nothing to attach to and renders nowhere, so handing the list the findings alone
 * would still show nothing.
 *
 * They go into the same list as every other rule rather than a section of their own. A second list
 * carries a second count, and two counts for one review are how the earlier split presentation came
 * to contradict itself.
 *
 * Deliberately *not* fed into the score. `AnalysisPanel` rescores from the review's own
 * `ruleResults`, and these rows are a display projection of a verdict ART has already scored —
 * adding them there would count the same judgement twice.
 */

import { VALIDATION_RULES } from '../engine/validation/ai-nodes/catalog';
import type {
  ArtFinding,
  ArtOrchestration,
  ArtOrchestrationFinding,
  ArtRuleResult,
} from '../models/art';

/** The row's family, and the word the list uses when it labels the affected skills. */
const FAMILY = 'Cross-skill';

/** The evaluator reached a verdict on every rule. Any other status leaves them unjudged. */
const COMPLETE = 'complete';

export interface CrossSkillRows {
  ruleResults: ArtRuleResult[];
  findings: ArtFinding[];
}

const EMPTY: CrossSkillRows = { ruleResults: [], findings: [] };

/** The rules the cross-skill node answers for, with the titles this app already ships for them. */
function crossSkillCatalog(): { id: string; title: string }[] {
  return VALIDATION_RULES
    .filter(rule => rule.nodes.includes('cross-skill'))
    .map(rule => ({ id: rule.id, title: rule.contract.title }));
}

/**
 * The list indexes findings by **rule** id, not by finding id, so that is what `id` has to carry.
 * `componentIdUnique` is left unset because the finding is about the set, not about a component.
 */
function toFinding(finding: ArtOrchestrationFinding): ArtFinding {
  return {
    id: finding.ruleId,
    family: FAMILY,
    severity: finding.severity,
    title: finding.title,
    fact: finding.evidence,
    why: finding.rationale,
    fix: finding.recommendation,
    ai: true,
  };
}

/**
 * One outcome per skill the finding names, so the row's affected list says which skills are
 * involved — the same fact the PDF prints as "Skills: a, b".
 *
 * `subjectId` is deliberately omitted. These are skill names, not component ids, and the affected
 * list renders an entry without an id as plain text rather than as a link, so naming them here
 * cannot produce a control that opens nothing.
 */
function toOutcomes(finding: ArtOrchestrationFinding, index: number): ArtRuleResult[] {
  const base = {
    ruleId: finding.ruleId,
    family: FAMILY,
    status: finding.severity,
    kind: 'check' as const,
    title: finding.title,
  };

  if (finding.skills.length === 0) {
    return [{ ...base, key: `${finding.ruleId}:${index}` }];
  }

  return finding.skills.map(skill => ({
    ...base,
    key: `${finding.ruleId}:${index}:${skill}`,
    subject: skill,
  }));
}

/**
 * Outcomes and findings for the cross-skill rules, ready to concatenate onto the review's own.
 *
 * Returns nothing when the review carries no orchestration at all. That is the shape of a review
 * whose evaluator never ran — a single-skill agent never opens the node's two-skill gate — and
 * six invented passes would report that unexamined set as clean.
 */
export function crossSkillRows(orchestration: ArtOrchestration | undefined): CrossSkillRows {
  if (!orchestration) return EMPTY;

  const ruleResults: ArtRuleResult[] = [];
  const findings: ArtFinding[] = [];
  const raised = new Set<string>();

  orchestration.findings.forEach((finding, index) => {
    raised.add(finding.ruleId);
    findings.push(toFinding(finding));
    ruleResults.push(...toOutcomes(finding, index));
  });

  // A rule the evaluator did not raise passed, which is the host's contract for every AI node: the
  // model reports exceptions, and silence on a rule it was asked to judge is a pass. That only
  // holds once it finished, so an unfinished run leaves the rest unjudged instead.
  const complete = orchestration.status === COMPLETE;
  for (const rule of crossSkillCatalog()) {
    if (raised.has(rule.id)) continue;
    ruleResults.push({
      key: rule.id,
      ruleId: rule.id,
      family: FAMILY,
      kind: 'check',
      title: rule.title,
      status: complete ? 'passed' : 'failed',
      note: complete
        ? undefined
        : `The cross-skill evaluator did not finish. It reported "${orchestration.status}".`,
    });
  }

  return { ruleResults, findings };
}
