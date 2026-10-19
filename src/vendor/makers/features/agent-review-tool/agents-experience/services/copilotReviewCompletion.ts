import type { CopilotReviewDisplayPayload, ReviewResult } from '../../contracts/ReviewResult';

/**
 * Separate review execution failures from findings about the reviewed agent.
 * Historical snapshots are inspected without changing their stored scores.
 */
export function getCopilotReviewCompletion(
  payload: CopilotReviewDisplayPayload,
): Pick<ReviewResult, 'status' | 'errorMessage'> {
  const incomplete: string[] = [];
  const reviews = payload.skillBundleReviews ?? [];
  const incompleteSkills = reviews.filter((review) => {
    const standard = 'standard' in review
      ? review.standard
      : 'standardEvaluation' in review ? review.standardEvaluation : undefined;
    const deep = 'deep' in review
      ? review.deep
      : 'deepEvaluation' in review ? review.deepEvaluation : undefined;
    return (review.status !== 'complete' && review.status !== 'blocked')
      || (standard !== undefined && standard.status !== 'complete')
      || (deep !== undefined && deep.status !== 'complete');
  });
  if (incompleteSkills.length > 0) {
    incomplete.push(`${incompleteSkills.length} skill assessment(s) did not complete`);
  }
  if (payload.bundleRetrievalIssues?.some((issue) =>
    issue.severity === 'error' || issue.code.includes('cancelled'))) {
    incomplete.push('skill resource loading did not complete');
  }
  const coverage = payload.analysisStatus?.instructionCoverage;
  if (coverage && coverage.state !== 'complete' && coverage.state !== 'not-applicable') {
    incomplete.push('instruction coverage did not complete');
  }
  if (payload.crossSkillOrchestration?.status !== undefined
    && payload.crossSkillOrchestration.status !== 'complete') {
    incomplete.push('cross-skill assessment did not complete');
  } else if (reviews.length > 0 && payload.analysisStatus && !payload.crossSkillOrchestration) {
    incomplete.push('cross-skill assessment is unavailable');
  }
  if (payload.score.status === 'partial') {
    incomplete.push('one or more deterministic checks did not complete');
  }
  return incomplete.length > 0
    ? {
        status: 'failed',
        errorMessage: `Review incomplete: ${incomplete.join('; ')}. Completed checks and findings are retained.`,
      }
    : { status: 'completed' };
}
