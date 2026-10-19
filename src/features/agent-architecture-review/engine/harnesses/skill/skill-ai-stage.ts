/**
 * The skill harness's AI stage: ART's judgement, this engine's plumbing.
 *
 * `createArtifactAiStageCore` decides everything about the assessment. This module supplies the two
 * things it cannot know inside a snapshot — how to reach a model, and what the upload is called —
 * and hands back the job id so the snapshot can be resumed.
 *
 * ## Why not ART's own `createArtifactAiStage`
 *
 * It builds its ports from ART's generated Dataverse client, which is bound to ART's app identity
 * and its data sources, and it names the upload by the artifact hash. A snapshot needs its own job
 * port — the row has to carry `cat_correlationid` so results can be collected back onto the right
 * snapshot — and it needs a subject id that survives an edit, or a re-review would look like a
 * different skill every time. See `harness-skill.md` §3.3.
 *
 * ## Why the job kind still says `ArtifactBundle`
 *
 * That is what an upload is, and it is what ART sends today for every upload, split or not. The
 * harness is what separates a skill from an agent, and that is recorded separately as `Skill`.
 */

import type { ReviewJobPort } from '../../dispatch/review-job-port';
import { createArc2WorkflowGuard } from '../../dispatch/ai-workflow-guard';
import {
  AIServiceCore,
  AI_MODEL_IDS,
  bindPromptReviewAiPort,
  bindWorkflowReviewAiPort,
  createArtifactAiStageCore,
  WorkflowReviewAiProviderCore,
  type ArtifactWorkflowBinding,
  type PredictTransport,
  type ReviewModelIds,
} from '../../scoring/art-ports';
import type { SkillIdentity } from './skill-identity';

/** Progress the AI stage reports while the workflow runs. */
export interface SkillAiProgress {
  message: string;
  /** Components the workflow has finished, when it has said. */
  completedComponents?: number;
  componentCount?: number;
}

export interface SkillAiStageOptions {
  identity: SkillIdentity;
  jobs: ReviewJobPort;
  predict: PredictTransport;
  /** Reported as soon as the durable job row exists, so an interrupted run can re-attach. */
  onJobSubmitted?: (jobId: string) => void;
  onProgress?: (progress: SkillAiProgress) => void;
  /** Attach to a job already running instead of submitting a new one. */
  existingJobId?: string;
  modelIds?: ReviewModelIds;
  signal?: AbortSignal;
}

/**
 * The stage, plus the job id it submitted.
 *
 * The id is read after the review rather than returned by it, because `runAiStage` has to match the
 * signature `reviewArtifact` expects and that signature has no room for it.
 */
export interface SkillAiStage {
  runAiStage: ReturnType<typeof createArtifactAiStageCore>;
  readonly submittedJobId: string | null;
  /** Surface a disabled parent even when ART retained a partial deterministic artifact review. */
  ensureWorkflowSettled(): Promise<void>;
}

/**
 * Build the AI stage for one uploaded skill.
 *
 * The workflow is always bound. Unlike an agent review — which skips it when the agent declares no
 * skills, so as not to spend a run on an empty job — an upload always has exactly the one bundle the
 * user is asking about, so there is never a reason to submit nothing.
 */
export function createSkillAiStage(options: SkillAiStageOptions): SkillAiStage {
  const modelIds = options.modelIds ?? { ...AI_MODEL_IDS };
  const workflow = createArc2WorkflowGuard(options.jobs, options.predict);
  const prompt = bindPromptReviewAiPort(new AIServiceCore(workflow.predict, { modelIds }));
  let provider: WorkflowReviewAiProviderCore | undefined;

  const runAiStage = createArtifactAiStageCore({
    promptPort: prompt,
    promptProvisioned: Boolean(modelIds.SKILL_BUNDLE_EVAL),
    // No `planPortions`: an upload is reviewed as one component here. Splitting is ART's opt-in
    // experiment, and a snapshot has a second reason to leave it alone — its progress and its
    // per-agent rows are both counted per agent, and a split would make one agent report several.
    bindWorkflow: ({ bundleName, signal }) => {
      provider = new WorkflowReviewAiProviderCore(
        {
          // The subject, never the content hash: a re-review exists because the bytes changed, so
          // hashing them would make every snapshot a different agent.
          botId: options.identity.subjectId,
          botName: bundleName,
          sourceEnvironment: '',
          harness: 'Skill',
          jobKind: 'ArtifactBundle',
          strictTransportErrors: true,
          ...(options.existingJobId ? { existingJobId: options.existingJobId } : {}),
          ...(signal ?? options.signal ? { signal: signal ?? options.signal } : {}),
          ...(options.onJobSubmitted ? { onJobSubmitted: options.onJobSubmitted } : {}),
          onProgress: (p) =>
            options.onProgress?.({
              message: p.message,
              ...(p.completedComponents !== undefined
                ? { completedComponents: p.completedComponents }
                : {}),
              ...(p.componentCount !== undefined ? { componentCount: p.componentCount } : {}),
            }),
        },
        workflow.jobs,
      );

      const binding: ArtifactWorkflowBinding = {
        port: bindWorkflowReviewAiPort(provider, prompt),
        prime: (portions, deterministicFindings, capabilityModel) =>
          provider!.prime([...portions], deterministicFindings, capabilityModel),
      };
      return binding;
    },
  });

  return {
    runAiStage,
    ensureWorkflowSettled: () => workflow.finish(provider?.submittedJobId ?? null, options.signal),
    get submittedJobId() {
      return provider?.submittedJobId ?? null;
    },
  };
}
