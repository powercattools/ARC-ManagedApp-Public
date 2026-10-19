import type { ReviewAiPort } from '../CopilotReviewService';
import type { WorkflowReviewAiProviderCore } from './WorkflowReviewAiProviderCore';

export const WORKFLOW_SERVED_MODEL_ID = 'workflow-served';

/** Bind all existing AI stages without importing a generated transport or losing workflow overrides. */
export function bindPromptReviewAiPort(service: Required<ReviewAiPort>): Required<ReviewAiPort> {
  return {
    invokeSkillBundleEvaluator: service.invokeSkillBundleEvaluator.bind(service),
    invokeInstructionCoverage: service.invokeInstructionCoverage.bind(service),
    invokeStandardSkillBundleEvaluator: service.invokeStandardSkillBundleEvaluator.bind(service),
    invokeSkillResourceChunkEvaluator: service.invokeSkillResourceChunkEvaluator.bind(service),
    invokeSkillFileSynthesizer: service.invokeSkillFileSynthesizer.bind(service),
    invokeDeepSkillBundleSynthesizer: service.invokeDeepSkillBundleSynthesizer.bind(service),
    invokeCrossSkillOrchestrator: service.invokeCrossSkillOrchestrator.bind(service),
  };
}

/**
 * Keep deep stages on the original AI Builder engine, and serve the two
 * workflow-owned stages from the workflow alone.
 *
 * D-4: there is no AI Builder fallback. A stage the workflow does not serve
 * returns null so the caller degrades, rather than silently paying for a prompt.
 */
export function bindWorkflowReviewAiPort(
  provider: WorkflowReviewAiProviderCore, prompt: Required<ReviewAiPort>,
): Required<ReviewAiPort> {
  return {
    ...prompt,
    invokeStandardSkillBundleEvaluator: provider.invokeStandardSkillBundleEvaluator,
    invokeCrossSkillOrchestrator: (_payload, skills, corpus) =>
      provider.invokeCrossSkillOrchestrator(skills, corpus),
    invokeInstructionCoverage: (instructions) =>
      provider.invokeInstructionCoverage(instructions),
  };
}
