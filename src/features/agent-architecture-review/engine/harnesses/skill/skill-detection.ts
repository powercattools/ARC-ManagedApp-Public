/**
 * Detection: what did the author upload, and how many reviewable things are in it?
 *
 * This module takes the place `expandAgentGraph` holds for the other two harnesses. An upload has no
 * bot row to walk, so the file itself is asked instead — and the answer is a **list**, never a
 * number this engine knows in advance (`harness-skill.md` §2.3, D-1).
 *
 * ART pins its own count at 1 because its dialog reviews one upload, and today its reader bails out
 * of a multi-skill archive (`artifactReader.detectNestedSkillFolder`), so this list happens to have
 * one entry. That is a fact about ART's reader, not a fact about snapshots. Every count downstream —
 * work items, agent rows, progress totals — is derived from what this returns, so the day ART lifts
 * that restriction a snapshot produces *n* rows with no change in this repository.
 *
 * Browser-safe. No `Buffer`, no `process`, no generated Dataverse client.
 */

import {
  detectArtifactKind,
  type ArtifactKind,
  type UploadedArtifact,
} from '../../scoring/art-ports';
import { deriveSkillIdentity, type SkillIdentity } from './skill-identity';

/** One reviewable artifact found inside an upload. */
export interface DetectedSkill {
  /** `skill` or `automation`, decided by the files and never asked of the user. */
  kind: ArtifactKind;
  /** Path of the file that identified it, relative to any single root folder. */
  primaryPath?: string;
  /** Both identities, derived once here and carried unchanged to the job port and to persistence. */
  identity: SkillIdentity;
  /**
   * The artifact to hand to ART's reviewer for this skill.
   *
   * The whole upload today, because one upload is one skill. When ART learns to split a multi-skill
   * archive this becomes that skill's own slice, and nothing downstream changes: callers review
   * whatever is on the entry they were given.
   */
  artifact: UploadedArtifact;
}

export interface SkillDetectionResult {
  skills: DetectedSkill[];
  /**
   * Why nothing reviewable was found, in the author's words.
   *
   * Set only when `skills` is empty, and taken verbatim from ART's detector so the sentence a reader
   * sees here is the sentence they would see in the Agent Review Tool for the same file.
   */
  reason?: string;
}

/**
 * Decide what is in an upload.
 *
 * Detection is deliberately total: an unreviewable upload returns an empty list with a reason rather
 * than throwing, because "this archive is not a skill" is an answer the dialog should render, not a
 * failure it should report as a crash.
 */
export function detectSkills(artifact: UploadedArtifact): SkillDetectionResult {
  const { kind, primaryPath, reason } = detectArtifactKind(artifact);

  // `kind` and `reason` are both optional on ART's contract, and exactly one is ever set. A missing
  // kind is the "nothing reviewable here" answer, whatever reason came with it.
  if (!kind) {
    return { skills: [], ...(reason ? { reason } : {}) };
  }

  return {
    skills: [
      {
        kind,
        ...(primaryPath ? { primaryPath } : {}),
        identity: deriveSkillIdentity(artifact),
        artifact,
      },
    ],
  };
}
