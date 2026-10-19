/**
 * Projects a standalone skill-bundle review onto the shared consolidated findings model.
 *
 * The uploaded-bundle review and the agent review answer the same question — which rules were
 * applied to this subject, and what did each one conclude — but they arrive in different shapes.
 * An agent review is already a list of per-rule outcomes; an `ArtifactReviewResult` records only
 * the rules that had something to say. Rendering it as it stands therefore shows a reader what
 * went wrong and never what was checked, which is the half of the report that earns the score.
 *
 * This adapter closes that gap the way the rest of the system does: the rules that produced a
 * finding become failing outcomes, and every other rule registered for the `standalone-skill`
 * harness becomes a pass. That is the user's stated contract — a rule absent from the findings is
 * a rule that passed — and it is why the pass list is derived from the registry rather than from
 * the review, which has no record of a rule that found nothing.
 *
 * It lives beside the panel rather than in `engine/` for the same reason `daFindings.ts` does:
 * `@review-ui` is a React barrel, so a pure-data module imports the individual module instead.
 */
import {
  buildConsolidatedView,
  type ConsolidatedView,
  type FindingInput,
  type RuleOutcomeInput,
} from '@review-ui/consolidatedFindings';

import type { ArtifactFinding, ArtifactReviewResult, Rule } from '../engine/scoring/art-ports';
import { rulesFor } from '../engine/scoring/art-ports';

/**
 * Bundle severities are a five-step scale; the consolidated model carries three.
 *
 * `critical` and `high` both mean the bundle fails on this rule, and `medium` and `low` both mean
 * it is worth attention without failing. Collapsing them here keeps one bucket vocabulary across
 * both harnesses; the original severity is still shown, because the drawer reads it from the rule.
 */
function toneOf(severity: string): FindingInput['severity'] {
  if (severity === 'critical' || severity === 'high') return 'error';
  if (severity === 'info') return 'info';
  return 'warning';
}

/** `scope_discipline` / `scope-discipline` -> `Scope discipline`. */
function label(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

/**
 * The grouping axis a row is filed under.
 *
 * The rule's own pillar is preferred because it is declared once and shared with the scorer. A
 * rule that spells a pillar per harness (D-14) has no single answer, and an unregistered id has
 * none at all, so the finding's rubric dimension is the fallback before the generic heading.
 */
function familyOf(rule: Rule<never> | undefined, dimension: string | undefined): string {
  if (rule && typeof rule.pillar === 'string') return label(rule.pillar);
  if (dimension) return label(dimension);
  return 'Skill review';
}

function findingInput(finding: ArtifactFinding, index: number, family: string): FindingInput {
  const steps = [...(finding.fixSteps ?? [])]
    .sort((a, b) => a.order - b.order)
    .map((step) => step.action)
    .filter((action) => !!action);

  const fact = finding.fact || finding.evidence;
  const why = finding.whyItMatters || finding.why;
  const fix = finding.makerAction || finding.recommendation || finding.fix;
  const reference = finding.referenceIds?.[0];

  return {
    id: finding.id || `${finding.ruleId}:${index}`,
    family,
    severity: toneOf(finding.severity),
    title: finding.findingTitle || finding.title,
    ...(fact ? { fact } : {}),
    ...(why ? { why } : {}),
    ...(fix ? { fix } : {}),
    ...(finding.acceptanceCheck ? { acceptanceCheck: finding.acceptanceCheck } : {}),
    ...(steps.length ? { fixSteps: steps } : {}),
    ...(finding.confidence ? { confidence: finding.confidence } : {}),
    ...(finding.suggestedText ? { suggestedText: finding.suggestedText } : {}),
    ...(finding.resourcePath ? { fieldPath: finding.resourcePath } : {}),
    ai: !!finding.ai,
    ...(reference ? { referenceId: String(reference) } : {}),
  };
}

/**
 * Builds the consolidated view for one uploaded bundle.
 *
 * Passes are synthesised only for a review that recorded the rule-set version that produced it.
 * A legacy row predates that field, so the rules it ran cannot be known — and claiming a rule
 * passed when there is no evidence it was ever applied is the one failure mode worth refusing.
 * Such a review still renders its findings; it simply shows no pass list.
 */
export function buildArtifactFindingsView(result: ArtifactReviewResult): ConsolidatedView {
  const registered = rulesFor('standalone-skill');
  const byId = new Map(registered.map((rule) => [rule.id, rule]));

  const findings: FindingInput[] = [];
  const worstByRule = new Map<string, FindingInput['severity']>();

  (result.findings ?? []).forEach((finding, index) => {
    const rule = byId.get(finding.ruleId);
    const family = familyOf(rule, finding.dimension);
    const input = findingInput(finding, index, family);
    findings.push(input);

    const seen = worstByRule.get(finding.ruleId);
    if (!seen || seen === 'info' || (seen === 'warning' && input.severity === 'error')) {
      worstByRule.set(finding.ruleId, input.severity);
    }
  });

  const outcomes: RuleOutcomeInput[] = [];

  for (const [ruleId, severity] of worstByRule) {
    const rule = byId.get(ruleId);
    outcomes.push({
      key: ruleId,
      ruleId,
      family: familyOf(rule, undefined),
      status: severity,
      ...(rule?.title ? { title: rule.title } : {}),
    });
  }

  if (result.evaluatorVersion !== undefined) {
    for (const rule of registered) {
      if (worstByRule.has(rule.id)) continue;

      /**
       * A deterministic-only review never ran its AI rules, so they are reported as unable to run
       * rather than as passes. Stamping them green would show the reader a check that was never
       * performed, which is worse than showing nothing.
       */
      const skipped = rule.execution === 'ai' && result.aiAvailable === false;

      outcomes.push({
        key: rule.id,
        ruleId: rule.id,
        family: familyOf(rule, undefined),
        status: skipped ? 'failed' : 'passed',
        ...(rule.title ? { title: rule.title } : {}),
        ...(skipped
          ? { note: 'The AI stage did not run for this review, so this rule was not applied.' }
          : {}),
      });
    }
  }

  return buildConsolidatedView(outcomes, findings, undefined, {});
}
