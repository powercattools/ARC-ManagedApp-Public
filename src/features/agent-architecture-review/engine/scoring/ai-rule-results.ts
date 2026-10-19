import {
  LEGACY_PILLAR_NAME, SEVERITY_TO_LEGACY,
  type AgentPillar, type RuleEvaluationResult, type RuleEvaluationStatus,
} from './art-ports';
import type { AiReviewAssessment } from './ai-review-contracts';

/**
 * Projects merged AI assessments onto the rule-result rows the shared pillar scorer reads.
 *
 * This is the seam that makes "one scorer" literally true. Without it the AI half of a review has
 * to be scored by its own arithmetic (`scoreAiReview`), which is how the two halves of the same
 * agent came to be graded by two different formulas with two weight tables. An AI rule and a
 * deterministic rule are both just rules: they differ in who decides the outcome, not in what an
 * outcome is worth, so once an assessment is stated as a `RuleEvaluationResult` the existing
 * credit arithmetic in `scoreLegacyDeterministicRules` applies to it unchanged.
 *
 * Nothing here invents a verdict. Every row is a restatement of a decision the merge already made.
 */

/**
 * The status an assessment's outcome and severity amount to.
 *
 * The three failure spellings are not interchangeable, and the mapping is the whole reason this
 * function exists rather than a ternary at the call site:
 *
 * - `not-applicable` leaves the pillar's denominator, so an agent is never punished for a rule
 *   that could not apply to it.
 * - `not-assessed` becomes `failed`, which is the scorer's word for *the rule could not run* —
 *   distinct from the agent failing it. It is excluded from the ratio **and** marks the pillar
 *   incomplete, so a missing AI answer suppresses the composite instead of silently scoring as a
 *   pass. This is the single most important row in the table: the opposite choice is exactly how a
 *   score gets manufactured from evidence that was never gathered.
 * - a real failure is graded by the rule's severity, so a `medium` costs half credit.
 * - an `info` rule is excluded from both sides of the ratio **whatever its outcome**, which is why
 *   severity is read before the outcome rather than after it. `creditFor` (`rule.ts:450`) returns
 *   `null` for an info rule without ever inspecting the outcome, so an info rule that happens to
 *   pass must not earn credit either — grading it `passed` would let a purely informational check
 *   raise a score, which is the same manufactured number as counting an unanswered rule as a pass,
 *   just in the opposite direction.
 */
export function aiRuleStatus(assessment: AiReviewAssessment): RuleEvaluationStatus {
  if (assessment.applicability.state === 'not-applicable') return 'not-applicable';
  if (assessment.severity === 'info') return 'info';
  if (assessment.outcome === 'not-assessed') return 'failed';
  if (assessment.outcome === 'pass') return 'passed';
  return SEVERITY_TO_LEGACY[assessment.severity];
}

/**
 * The legacy family name the scorer falls back on when a rule is not in the registry.
 *
 * `pillarForResult` prefers the registry and reads `family` only if the lookup misses, so this is
 * a backstop rather than a second pillar table — it restates the group the merge already resolved
 * from the catalog. A skill dimension has no agent-pillar spelling, so it yields `undefined` and
 * the row is left out of the agent pillars rather than being forced into one it does not belong
 * to; standalone-skill reviews are scored on their own dimensions by their own path (D-13).
 */
function familyOf(assessment: AiReviewAssessment): string {
  const group = assessment.scoringGroup;
  return group && Object.hasOwn(LEGACY_PILLAR_NAME, group)
    ? LEGACY_PILLAR_NAME[group as AgentPillar]
    : '';
}

/**
 * One rule-result row per merged assessment.
 *
 * `scoreOwnerKey` is reused as the row key rather than a fresh string: the merge already built it
 * from harness, rule and subject precisely so one rule's claim about one subject has one identity.
 * Re-deriving it here would be a second way to say the same thing, and a per-skill rule whose two
 * keys disagreed would be double-counted by `dedupeRuleResults` instead of collapsing.
 */
export function aiRuleResults(assessments: readonly AiReviewAssessment[]): RuleEvaluationResult[] {
  return assessments.map(assessment => ({
    key: assessment.scoreOwnerKey,
    ruleId: assessment.ruleId,
    family: familyOf(assessment),
    status: aiRuleStatus(assessment),
    subjectId: assessment.subjectId,
    kind: assessment.kind,
  }));
}
