/**
 * What a snapshot reports while it runs.
 *
 * A snapshot reviews an agent and every agent it calls, so progress is two-dimensional: which agent
 * is being worked on, and how far that agent's own review has got. The dialog renders both — the
 * agent name in the heading, the stages beneath it — which is why this is one shared contract
 * rather than a per-harness invention.
 *
 * Pure types. No I/O, no host APIs, no ART imports.
 */

/**
 * The stages a single agent's review moves through.
 *
 * Deliberately coarser than the engine's internal steps. ART collapses roughly a dozen operations
 * into the same handful of user-facing rows, because a progress list that renames itself every two
 * seconds reads as churn rather than progress. `checking-compliance` in particular is an umbrella:
 * it covers the workflow's per-skill evaluation, cross-skill orchestration, instruction coverage and
 * any deep-resource stages that fall back to prompts.
 */
export type AgentReviewStage =
  | 'capturing'
  | 'parsing-configuration'
  | 'evaluating-patterns'
  | 'checking-compliance'
  | 'analyzing-runtime'
  | 'saving-results';

/** Terminal states for one agent within a snapshot. */
export type AgentReviewOutcome = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';

/** How an agent came to be in this snapshot. */
export type AgentRole = 'parent' | 'connected';

/** Progress for one agent. */
export interface AgentReviewProgress {
  agentId: string;
  agentName: string;
  role: AgentRole;
  outcome: AgentReviewOutcome;
  stage: AgentReviewStage;
  /** Free text beneath the stage, e.g. "Review agent is analysing 4 components". */
  detail?: string;
  /** Populated once the workflow reports component counts; drives "n of m". */
  componentCount?: number;
  completedComponents?: number;
  /** Set when `outcome` is `failed`. */
  error?: string;
  /** Durable job id, so a review survives the dialog closing. */
  jobId?: string;
  /** Final grounded score, once known. */
  score?: number;
}

/** Progress for the whole snapshot. */
export interface SnapshotProgress {
  snapshotId?: string;
  /** Every agent in the snapshot, parent first, in discovery order. */
  agents: AgentReviewProgress[];
  /** True once no agent is still running. */
  settled: boolean;
}

/** Callback the host passes in to render progress. */
export type SnapshotProgressListener = (progress: SnapshotProgress) => void;
