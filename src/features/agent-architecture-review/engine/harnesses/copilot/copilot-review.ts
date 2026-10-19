/**
 * The copilot (agents-experience) harness: review one captured agent under ART's rubric.
 *
 * Everything that decides a score happens inside ART. This module supplies the four things ART
 * cannot supply for itself — the components, the assembled bundles, a Dataverse-backed job port and
 * an AI Builder predict transport — and translates ART's progress into the shared snapshot
 * vocabulary. It contributes no rule, no weight and no threshold.
 *
 * ## Which stages the workflow serves
 *
 * With the workflow provider bound, the whole-skill evaluator, cross-skill orchestration and
 * instruction coverage are answered by the `Review Agent Components` flow. The deep-resource stages
 * — resource chunk evaluation, file synthesis and bundle synthesis — remain AI Builder prompts, and
 * so does every workflow stage when its reserved row is missing or malformed. That fallback is why
 * a predict transport is required even when the workflow is healthy.
 */

import type { CopilotAgentCapture } from '../../capture/agent-capture';
import type { ReviewJobPort } from '../../dispatch/review-job-port';
import { createArc2WorkflowGuard } from '../../dispatch/ai-workflow-guard';
import type { AgentReviewStage } from '../../contracts/review-progress';
import {
  AIServiceCore,
  AI_MODEL_IDS,
  bindPromptReviewAiPort,
  bindWorkflowReviewAiPort,
  buildPersistedCopilotReview,
  computeDeterministicFindingsByBundle,
  executeCopilotReview,
  WorkflowReviewAiProviderCore,
  WORKFLOW_SERVED_MODEL_ID,
  type AgentsExperienceReviewPayload,
  type PredictTransport,
  type ReviewAiPort,
  type ReviewModelIds,
} from '../../scoring/art-ports';

/** Progress this harness reports for a single agent. */
export interface CopilotReviewProgress {
  stage: AgentReviewStage;
  detail: string;
  componentCount?: number;
  completedComponents?: number;
}

export interface CopilotReviewOptions {
  capture: CopilotAgentCapture;
  jobs: ReviewJobPort;
  predict: PredictTransport;
  /** Reported as soon as the durable job row exists, so a closed dialog can be resumed. */
  onJobSubmitted?: (jobId: string) => void;
  onProgress?: (progress: CopilotReviewProgress) => void;
  /** Attach to a job already running instead of submitting a new one. */
  existingJobId?: string;
  modelIds?: ReviewModelIds;
  signal?: AbortSignal;
}

export interface CopilotReviewOutcome {
  payload: AgentsExperienceReviewPayload;
  /** The projection that gets persisted and rendered. */
  persisted: ReturnType<typeof buildPersistedCopilotReview>;
  /** ART's grounded score, or null when the rubric could not produce one. */
  score: number | null;
  jobId: string | null;
  startedAt: string;
  completedAt: string;
}

/**
 * Map ART's free-text stage strings onto the six user-facing rows.
 *
 * ART emits far more stages than the dialog shows. Rather than render each one, they are collapsed
 * the same way ART's own progress adapter collapses them, so the two products describe the same
 * review in the same words.
 */
function toStage(artStage: string): AgentReviewStage {
  const stage = artStage.toLowerCase();
  if (stage.includes('loading') || stage.includes('component')) return 'parsing-configuration';
  if (stage.includes('rule') || stage.includes('pattern') || stage.includes('grounded')) {
    return 'evaluating-patterns';
  }
  return 'checking-compliance';
}

/**
 * Review one captured agent.
 *
 * The workflow provider is primed from inside `getSkillBundles` rather than before the call,
 * because priming submits the job: doing it there means the Dataverse trigger latency is paid once
 * per review, at the point the orchestrator actually has bundles to send, instead of once per skill.
 *
 * `prime()` returns as soon as the job row is queued and polls in the background, so this function
 * is safe to run concurrently for several agents — which is exactly how a snapshot reviews an agent
 * and its connected agents without multiplying wall-clock time by the number of agents.
 */
export async function reviewCopilotAgent(
  options: CopilotReviewOptions,
): Promise<CopilotReviewOutcome> {
  const { capture, jobs, predict, onProgress, signal } = options;
  const modelIds = options.modelIds ?? { ...AI_MODEL_IDS };
  const startedAt = new Date().toISOString();

  const report = (stage: AgentReviewStage, detail: string, extra?: Partial<CopilotReviewProgress>) =>
    onProgress?.({ stage, detail, ...extra });

  const workflow = createArc2WorkflowGuard(jobs, predict);
  const prompt = bindPromptReviewAiPort(new AIServiceCore(workflow.predict, { modelIds }));

  // A review with no skills has nothing for the workflow to evaluate. Submitting anyway would cost a
  // run, produce a job the workflow completes with zero components, and clutter the job history.
  const useWorkflow = capture.bundles.length > 0;

  const provider = useWorkflow
    ? new WorkflowReviewAiProviderCore(
        {
          botId: capture.botId,
          botName: capture.botName,
          sourceEnvironment: capture.organization,
          harness: 'Copilot',
          // Let the ARC2 guard reject disabled agent-level stages before prompt fallback.
          strictTransportErrors: true,
          ...(options.existingJobId ? { existingJobId: options.existingJobId } : {}),
          ...(signal ? { signal } : {}),
          onJobSubmitted: options.onJobSubmitted,
          onProgress: (p) =>
            report('checking-compliance', p.message, {
              componentCount: p.componentCount,
              completedComponents: p.completedComponents,
            }),
        },
        workflow.jobs,
      )
    : undefined;

  const ai: ReviewAiPort = provider ? bindWorkflowReviewAiPort(provider, prompt) : prompt;

  report('parsing-configuration', 'Reading agent configuration');

  const payload = await executeCopilotReview(
    capture.botId,
    capture.configuration,
    {
      ai,
      // Components and bundles were captured up front, so neither stage re-reads Dataverse. A
      // second read could disagree with the first and grade a mixture of two agent versions.
      getBotComponents: async () => capture.components,
      getSkillBundles: async (_id, model) => {
        if (provider) {
          await provider.prime(
            capture.bundles,
            computeDeterministicFindingsByBundle(capture.bundles),
            model,
          );
        }
        return capture.bundles;
      },
      skillEvalModelId: modelIds.SKILL_BUNDLE_EVAL,
      coverageModelId: provider ? WORKFLOW_SERVED_MODEL_ID : modelIds.INSTRUCTION_COVERAGE,
      skillResourceEvalModelId: modelIds.SKILL_RESOURCE_EVAL,
      fileSynthesisModelId: modelIds.SKILL_FILE_SYNTHESIS,
      deepBundleSynthesisModelId: modelIds.SKILL_DEEP_BUNDLE_SYNTHESIS,
      crossSkillOrchestrationModelId: provider
        ? WORKFLOW_SERVED_MODEL_ID
        : modelIds.SKILL_CROSS_SKILL_ORCHESTRATION,
    },
    (stage) => report(toStage(stage), stage),
    signal,
  );

  await workflow.finish(provider?.submittedJobId ?? null, signal);

  const completedAt = new Date().toISOString();

  const persisted = buildPersistedCopilotReview({
    payload,
    bundles: capture.bundles,
    mode: payload.skillReviewMode ?? 'standard',
    startedAt,
    completedAt,
  });

  return {
    payload,
    persisted,
    score: payload.score.grounded,
    jobId: provider?.submittedJobId ?? null,
    startedAt,
    completedAt,
  };
}
