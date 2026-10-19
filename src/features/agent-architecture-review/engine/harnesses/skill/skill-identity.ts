/**
 * The two identities an uploaded skill carries, derived once (spec 015, `harness-skill.md` §3.3).
 *
 * An upload has no bot record, so both identities are fabricated. They answer different questions
 * and must not be collapsed into one:
 *
 *  - **Subject** — "is this the same skill as last time?" Persisted as `cat_agentid` and carried
 *    inside `cat_correlationid`. It must survive an edit, because a re-review exists precisely
 *    because the content changed.
 *  - **Content** — "which exact bytes were graded?" Stored beside the artifact file name on the
 *    result row, and never used to match snapshots to one another.
 *
 * ART uses the content hash as its `botId` (`uploadBundleAdapter.SYNTHETIC_ID_PREFIX`), which is
 * right for ART: its subject *is* one upload. Using it here would mean every re-review looked like a
 * different subject, which breaks the Recommendations tab the moment it is built — tracking whether
 * a recommendation was acted on means matching a skill to its earlier self, and acting on a
 * recommendation is exactly what changes the bytes.
 *
 * Derived once, at detection, and carried on the work item. `snapshot-persistence` and
 * `review-job-port` must be handed the *same* subject id: if they disagree the correlation join
 * returns nothing, the job completes, and its results are never collected onto the snapshot.
 */

import { findFile, parseFrontmatter, readString, type UploadedArtifact } from '../../scoring/art-ports';

/** Marks every subject identifier this module fabricates. */
export const SKILL_SUBJECT_PREFIX = 'skill:';

export interface SkillIdentity {
  /** Stable across snapshots. `cat_agentid`, and the `botId` written into the review corpus. */
  subjectId: string;
  /** Display name, exactly as the author wrote it. `cat_agentname`. */
  displayName: string;
  /** SHA-256 over the uploaded bytes. Identifies the exact artifact graded, never the subject. */
  contentHash: string;
}

/**
 * Fold a skill name to its comparison form.
 *
 * Case and surrounding whitespace only. Nothing here may merge two names an author would read as
 * different, so punctuation and internal spacing are left alone — `weather-lookup` and
 * `weather lookup` stay distinct, because a maker who renamed one to the other meant something by
 * it and the snapshot series should say so.
 */
export function normaliseSkillName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The name an author gave the skill, or undefined when the artifact declares none.
 *
 * Read from `SKILL.md` frontmatter, which is the same field ART holds to account: `PKG-NAME`
 * compares it against the bundle's root folder, and that mismatch is the most common upload
 * failure. A Scout automation has no frontmatter, so this returns undefined and the caller falls
 * back to the file name.
 */
export function skillNameFrom(artifact: UploadedArtifact): string | undefined {
  const markdown = findFile(artifact, 'SKILL.md')?.text;
  if (!markdown) return undefined;
  const declared = readString(parseFrontmatter(markdown).data, 'name')?.trim();
  return declared ? declared : undefined;
}

/**
 * Derive both identities for one uploaded artifact.
 *
 * The file name is the fallback subject, not an error: an automation `.json` and a bare `.md` both
 * carry a meaningful name in the file name itself, and refusing to review something because it
 * declared no frontmatter would reject uploads ART accepts.
 */
export function deriveSkillIdentity(artifact: UploadedArtifact): SkillIdentity {
  const displayName = skillNameFrom(artifact) ?? artifact.fileName;
  return {
    subjectId: `${SKILL_SUBJECT_PREFIX}${normaliseSkillName(displayName)}`,
    displayName,
    contentHash: artifact.hash,
  };
}

/**
 * Whether a re-uploaded artifact names the same skill the series has been reviewing.
 *
 * Name only. Comparing the file contents would answer the wrong question — a re-review exists
 * because the content changed, so a difference proves nothing and equality proves only "identical
 * upload". Neither separates "renamed and edited" from "a different skill", because both present as
 * *name differs, content differs*. A similarity score would need a threshold, and a threshold is a
 * guess that is wrong in both directions.
 *
 * An unknown previous subject — the first snapshot in a series, or one recorded before this harness
 * existed — is not a mismatch. There is nothing to contradict.
 */
export function isSameSkillSubject(
  previousSubjectId: string | undefined,
  currentSubjectId: string | undefined,
): boolean {
  if (!previousSubjectId || !currentSubjectId) return true;
  return previousSubjectId === currentSubjectId;
}
