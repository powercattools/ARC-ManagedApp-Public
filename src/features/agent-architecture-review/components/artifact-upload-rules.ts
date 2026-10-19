/**
 * What the artifact upload field accepts, and the shape it reports upward.
 *
 * Separate from the component so both dialogs and their tests can import the rules without pulling
 * in a React tree, and so the component file exports only a component.
 */

import type { TargetRuntime, UploadedArtifact } from '../engine/scoring/art-ports';
import type { DetectedDeclarativeAgent } from '../engine/harnesses/declarative-agent/da-detection';

/**
 * Accepted artifact formats. A DA/Skill is not always a zip (FR-089a).
 *
 * `.json` is here for standalone Scout automations, which are a single file and never an archive
 * (`harness-skill.md` §2). Without it the runtime picker's automation path is unreachable.
 */
export const ACCEPTED_EXTENSIONS = ['.zip', '.md', '.yaml', '.yml', '.json'];

/**
 * 16 MB. Dataverse accepts a file this size in a single Web API call; above it the upload must be
 * split into 4 MB chunks, which Phase 1 does not need (FR-115a).
 */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

export function hasAcceptedExtension(fileName: string): boolean {
  return ACCEPTED_EXTENSIONS.some((extension) => fileName.toLowerCase().endsWith(extension));
}

export interface ArtifactSelection {
  file: File | null;
  /** Set only once the bytes were read and detection found something reviewable. */
  artifact: UploadedArtifact | null;
  /**
   * Set instead of `artifact` when the upload is a declarative agent package.
   *
   * Deliberately a separate field rather than a widened `artifact`: a DA package carries a parsed
   * manifest and its evidence, which an `UploadedArtifact` has no room for, and it is judged
   * without a runtime. Keeping them apart is what lets `ready` state each harness's own condition
   * instead of one condition that is wrong for both.
   */
  declarativeAgent: DetectedDeclarativeAgent | null;
  runtimes: TargetRuntime[];
  /** What detection found, in the order it found it. */
  detectedNames: string[];
  /** Stable subject ids for what was found, used to tell a re-review from a different skill. */
  subjectIds: string[];
  /** True once there is enough to run: something reviewable, and a runtime to judge it against. */
  ready: boolean;
}

/**
 * Whether a selection has enough to run, by the rule its own harness states.
 *
 * A skill upload needs bytes *and* a runtime to judge them against. A declarative agent needs only
 * the package: there is no runtime to pick, so requiring one would leave Create permanently
 * disabled — which is exactly how the DA tile behaved before it was wired.
 */
export function isSelectionReady(selection: Pick<ArtifactSelection, 'artifact' | 'declarativeAgent' | 'runtimes'>): boolean {
  if (selection.declarativeAgent) return true;
  return Boolean(selection.artifact) && selection.runtimes.length > 0;
}

export const EMPTY_SELECTION: ArtifactSelection = {
  file: null,
  artifact: null,
  declarativeAgent: null,
  runtimes: [],
  detectedNames: [],
  subjectIds: [],
  ready: false,
};
