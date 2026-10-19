/**
 * Domain types for Agent Architecture Review (spec 015).
 *
 * These mirror the two Dataverse tables one-for-one — `cat_architecturereview`
 * and `cat_architecturereviewresult` — so the service layer maps rows straight
 * onto them.
 */

import { gradeForScore, type Grade, type TargetRuntime, type UploadedArtifact } from '../engine/scoring/art-ports';

/** What a review points at. Drives which variant of the create dialog is shown. */
export type AssetType = 'copilot-studio-agent' | 'declarative-agent' | 'skill';

/**
 * Lifecycle flag. Applies to a `Review` (archived off the landing grid) and,
 * separately, to a `ReviewResult` (only the newest result is Active — FR-116).
 */
export type LifecycleStatus = 'active' | 'inactive';

/**
 * Letter grade, on the ordinary A+ to F school scale.
 *
 * Chosen because it needs no explanation: a reviewer opening a report already knows what a C- means
 * relative to a B, and knows F is the failing end. An invented five-band vocabulary would have to be
 * taught before the number it labels could be read.
 *
 * The scale and the arithmetic live in `review-core/bands.ts` so both apps read one table — a band
 * list that exists twice is two lists that happen to agree. Grades are still never stored: a cached
 * letter can disagree with the score printed beside it once either the bands or the rubric move, and
 * a report that contradicts itself is worse than one that recomputes.
 */
export type { Grade };
export { gradeForScore };

export const ASSET_TYPE_LABELS: Record<AssetType, string> = {
  'copilot-studio-agent': 'Copilot Studio Agent',
  'declarative-agent': 'Declarative Agent',
  skill: 'Skill',
};

/**
 * Which rubric actually reviewed an agent.
 *
 * Not the same question as the asset type: one Copilot Studio agent is reviewed under the Copilot
 * harness or the Standard one depending on how it was authored, and only the engine's capture step
 * can tell which. Mirrors `HARNESS_OPTIONS` in the schema metadata.
 */
export type HarnessName = 'standard' | 'copilot' | 'declarative-agent' | 'skill';

export const HARNESS_LABELS: Record<HarnessName, string> = {
  standard: 'Standard',
  copilot: 'Copilot',
  'declarative-agent': 'Declarative Agent',
  skill: 'Skill',
};

/** Asset types whose artifact is uploaded rather than read from an environment. */
export const UPLOAD_ASSET_TYPES: readonly AssetType[] = ['declarative-agent', 'skill'];

export function isUploadAssetType(assetType: AssetType): boolean {
  return UPLOAD_ASSET_TYPES.includes(assetType);
}

/** A review project — the container the landing grid lists. */
export interface Review {
  id: string;
  projectName: string;
  assetType: AssetType;
  status: LifecycleStatus;
  ownerName: string;
  createdOn: string;
  /** Mirrors the newest Active result so the grid reads from one row. */
  currentScore: number | null;
  currentGrade: Grade | null;
  /**
   * The newest result, so the grid can open it without first asking which one that is.
   *
   * Null until a snapshot exists. A review with no result has nothing to open, and the grid says so
   * rather than navigating to a page that would have to explain itself.
   */
  currentResultId: string | null;
  /** The "3 components" column — the agent plus its dependencies. */
  targetComponentCount: number;
  lastRun: string | null;
  numberOfResults: number;
  /**
   * The harness the newest snapshot was reviewed under, when one has run.
   *
   * Absent until a snapshot exists, because nothing before that point knows it.
   */
  harness?: HarnessName;
  /** Target binding for `copilot-studio-agent` reviews. */
  environmentUrl?: string;
  environmentName?: string;
  botId?: string;
  botName?: string;
}

/** One graded snapshot of a review. The detail page renders these as a timeline. */
export interface ReviewResult {
  id: string;
  reviewId: string;
  sequenceNumber: number;
  score: number | null;
  grade: Grade | null;
  status: LifecycleStatus;
  runTimestamp: string;
  rulePackName: string;
  rulePackVersion: string;
  /** DA/Skill only — the artifact this result actually graded (FR-112). */
  artifactFileName?: string;
  /** Upload sequence: first upload is 1, the re-review upload is 2 (FR-114). */
  artifactVersion?: number;
  /**
   * What this snapshot reviewed, joined from its parent agent row on read.
   *
   * The bot id for a bot-backed harness, where it never changes. For an uploaded skill it is the
   * fabricated subject id, which *can* change: a re-review asks for a fresh upload, and the author
   * is free to pick a file naming a different skill.
   *
   * Absent for snapshots whose agent rows could not be read, which is not an error — it simply means
   * nothing is known to contradict, and comparison proceeds as before.
   */
  subjectId?: string;
  transcriptStart?: string;
  transcriptEnd?: string;
}

/** Values collected by the create dialog. */
export interface CreateReviewInput {
  projectName: string;
  assetType: AssetType;
  environmentUrl?: string;
  environmentName?: string;
  botId?: string;
  botName?: string;
  transcriptStart?: string;
  transcriptEnd?: string;
  artifactFileName?: string;
  /**
   * The uploaded bundle, already read into memory by the dialog.
   *
   * Transient, and deliberately not a column: the bytes drive this run and what is worth keeping
   * from them — the artifact's name, its hash and every finding — is already inside the review the
   * run writes. Its presence is also what marks an upload as reviewable: without it there is
   * nothing to review, and the snapshot would be created only to sit empty.
   */
  artifact?: UploadedArtifact;
  /**
   * The declarative agent package, as the author chose it, unread.
   *
   * The `File` rather than an `UploadedArtifact` because the engine's detector resolves the
   * manifest's internal references to find the agent and its plugins, which a flat list of file
   * names cannot answer. Transient for the same reason `artifact` is: the bytes drive this run and
   * everything worth keeping from them is inside the review it writes.
   *
   * Mutually exclusive with `artifact` — a file is one kind of package or the other, and the dialog
   * only ever sets the one the chosen tile asked for.
   */
  declarativeAgent?: File;
  /**
   * The runtimes the author ticked, judged against in the same review.
   *
   * Never inferred. A SKILL.md carries no marker naming its target platform, so choosing on the
   * author's behalf would silently pick a rubric (`harness-skill.md` §9).
   */
  runtimes?: TargetRuntime[];
}

/**
 * Values collected by the "Review the agent again" dialog.
 *
 * The transcript window is asked for again on every re-review rather than inherited, because the point
 * of a new snapshot is usually to look at a different period.
 */
export interface ReviewAgainInput {
  artifactFileName?: string;
  /**
   * The re-uploaded artifact, held in memory for the run and never persisted.
   *
   * A DA/Skill review cannot be re-run unattended — there is no environment to re-read from, so a
   * new artifact is always required (FR-113). Nothing is inherited from the previous snapshot.
   */
  artifact?: UploadedArtifact;
  /** The re-uploaded declarative agent package. Required for the same reason `artifact` is. */
  declarativeAgent?: File;
  /** Asked again rather than carried forward: a skill may have been rewritten for another runtime. */
  runtimes?: TargetRuntime[];
  transcriptStart?: string;
  transcriptEnd?: string;
}

/**
 * A newly created review together with its first snapshot.
 *
 * The result is returned rather than looked up afterwards because the caller needs its id immediately to
 * attach a runtime analysis to it, and re-reading to find "the one I just made" is a race.
 */
export interface CreatedReview {
  review: Review;
  result: ReviewResult;
}

/**
 * Trend between a result and the one before it. Derived on read, never stored,
 * so it cannot drift out of sync with the scores (OQ-40).
 */
export interface ResultTrend {
  direction: 'up' | 'down' | 'flat';
  percentage: number;
}

/**
 * Whether two snapshots reviewed different subjects.
 *
 * Only ever true for an uploaded skill, and only when the author's re-upload declared a different
 * name. A bot id does not change, and an unknown id on either side is not a contradiction — the
 * first snapshot of a series, and every snapshot recorded before subject ids were written, report
 * nothing at all.
 */
export function subjectChanged(result: ReviewResult, previous: ReviewResult | undefined): boolean {
  if (!previous || !result.subjectId || !previous.subjectId) return false;
  return result.subjectId !== previous.subjectId;
}

export function deriveTrend(
  result: ReviewResult,
  previous: ReviewResult | undefined,
): ResultTrend | null {
  if (!previous || previous.score === 0 || previous.score === null || result.score === null) return null;
  // Two scores for two different skills are two facts, not a trend. Rather than draw an arrow that
  // is arithmetically correct and factually meaningless, say nothing and let the caller warn.
  if (subjectChanged(result, previous)) return null;
  const delta = ((result.score - previous.score) / previous.score) * 100;
  const rounded = Math.round(delta);
  if (rounded === 0) return { direction: 'flat', percentage: 0 };
  return { direction: rounded > 0 ? 'up' : 'down', percentage: Math.abs(rounded) };
}
