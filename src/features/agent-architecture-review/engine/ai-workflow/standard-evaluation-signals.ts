import type { StandardAgentCapture } from '../capture/agent-capture';
import {
  computeCoverage, parseStandardComponents, standardCoverageModel,
  type AgentsExperienceModel, type BotComponent, type NormalizedEvaluationEvidence,
  type ParsedBotData, type UnifiedRuleAssessment,
} from '../scoring/art-ports';
import type { AiEvaluationSignals } from '../scoring/ai-review-scoring';

function unavailable(reason: string): AiEvaluationSignals {
  return {
    availability: 'unavailable', reason,
    hasUsableSet: null, hasCases: null, capabilityCoverageRatio: null,
    hasMultiTurnCoverage: null, expectedResponseRequirementSatisfied: null,
  };
}

/**
 * Projects a standard capture onto the part of `AgentsExperienceModel` that `computeCoverage`
 * reads.
 *
 * A second, standard-only coverage formula is what the projection exists to avoid: the two
 * harnesses would then answer "are this agent's capabilities actually exercised by its tests?"
 * with different arithmetic, and the same evidence would score differently depending on which
 * product built the agent. The evaluation rows need no mapping at all — `parseEvaluationSet`,
 * `parseEvaluationCase` and `parseMultiTurnEvaluationCase` already produced `Ae*` values for both
 * harnesses, which is why only the capability side is assembled there.
 *
 * The mapping itself now lives in ART beside the model it produces, because the scorer needs the
 * same projection this does. `standardCoverageModel` is the scoring model with its two delegation
 * populations merged, which is the one difference coverage requires — see its own note.
 */
function coverageModel(parsed: ParsedBotData, evidence: NormalizedEvaluationEvidence): AgentsExperienceModel {
  return standardCoverageModel(parsed, evidence);
}

/**
 * The standard harness' Agent Evaluation signals, derived from the same evidence the copilot
 * harness uses.
 *
 * Standard agents store evaluation sets and cases in the same `botcomponents` rows, read by the
 * same parsers, and the deterministic EVL rules already run against them — so the pillar was never
 * unmeasurable, it simply had no provider. Scoring it from a different formula, or continuing to
 * disclose it as unmeasured, would both mean a standard agent's 30 Evaluation points are decided
 * by its harness rather than by its tests.
 *
 * Confirmed absence and unreadable evidence stay distinct throughout: an agent with no evaluation
 * set returns `false`, which the scorer turns into a real zero, while evidence that could not be
 * read returns `null` and blocks the composite instead of scoring the agent as though it had
 * failed.
 */
export function standardEvaluationSignals(
  capture: StandardAgentCapture,
  components: BotComponent[],
  evidence: NormalizedEvaluationEvidence | undefined,
  assessments: readonly UnifiedRuleAssessment[],
): AiEvaluationSignals {
  if (!evidence) return unavailable('Standard Evaluation evidence was not normalized from this capture.');
  if (evidence.availability === 'unavailable') {
    return unavailable(evidence.diagnostics[0] ?? 'Captured Standard Evaluation evidence is unavailable.');
  }
  const parsed = parseStandardComponents(components, capture.botId, capture.botName, 'unknown', 'live');
  const coverage = computeCoverage(coverageModel(parsed, evidence));
  // EVL-04 already decides whether cases declare an expected response. Re-deciding it here would
  // let the pillar and its own rule disagree about the same captured rows.
  const expectedResponse = assessments.find(assessment => assessment.ruleId === 'EVL-04');
  // A parse failure only clouds the capability inventory when there were rows to parse. With no
  // components at all the parser reports the absence itself, and a proven-empty live capture is
  // complete evidence of an agent with no evaluations — exactly how the copilot harness reads it.
  const unreadableComponents = components.length > 0 && (parsed.parsingErrors?.length ?? 0) > 0;
  const incomplete = evidence.availability !== 'complete' || coverage.basis === 'unverified'
    || unreadableComponents;
  return {
    availability: incomplete ? 'partial' : 'complete',
    reason: `Captured evaluation configuration only; ${coverage.basis} capability coverage is not observed execution success.`,
    hasUsableSet: evidence.evaluationSets.length > 0 && evidence.testCases.length > 0,
    hasCases: evidence.testCases.length > 0,
    // An all-GeneralQualityGrader conversation set cannot show which capability a case exercised,
    // so its ratio is unknown rather than zero. The copilot harness blocks on exactly this.
    capabilityCoverageRatio: coverage.basis === 'unverified' ? null
      : coverage.total > 0 ? coverage.covered / coverage.total : 1,
    hasMultiTurnCoverage: evidence.multiTurnCases.length > 0,
    expectedResponseRequirementSatisfied: !expectedResponse || expectedResponse.incomplete
      || expectedResponse.outcome === 'could-not-run' ? null
      : expectedResponse.outcome === 'pass' || expectedResponse.outcome === 'not-applicable',
  };
}
