/**
 * Detection: is this upload a declarative agent package, and what is in it?
 *
 * A sibling of `skill/skill-detection.ts`, not a branch of it. The two answer the same question for
 * the dialog — "is there anything reviewable here?" — and share nothing else: a skill upload is a
 * list of skills judged against a chosen runtime, while a DA package is exactly one agent judged
 * against its own six-criterion rubric with no runtime at all. Folding them together would mean one
 * of the two carrying a field the other must remember to ignore.
 *
 * Detection is **total**, exactly as it is for skills: an upload that is not a DA package returns a
 * reason rather than throwing, because "this archive is not a declarative agent" is an answer the
 * dialog renders, not a failure it reports as a crash.
 *
 * Browser-safe. No `Buffer`, no `process`, no generated Dataverse client — everything imported here
 * comes through `art-ports`, which is where that guarantee is stated and kept.
 */

import {
  detectZipType,
  getDAIdentifier,
  parseDAZip,
  type DAManifest,
  type DAPackageEvidence,
  type SkillBundle,
  type ZipType,
} from '../../scoring/art-ports';

/** The reviewable contents of a declarative agent package. */
export interface DetectedDeclarativeAgent {
  /**
   * Stable subject id, derived by ART's own rule.
   *
   * The manifest's `appId` when it declares one, otherwise a hash over the stable manifest fields.
   * Deriving it rather than inventing one is what makes a re-review of the same package resolve to
   * the same subject, in this app and in the Agent Review Tool alike.
   */
  subjectId: string;
  /** The agent's own name, shown to the reader so they can confirm they uploaded what they meant. */
  displayName: string;
  manifest: DAManifest;
  /** Redacted, size-capped package contents. The grounding every finding is checked against. */
  packageEvidence: DAPackageEvidence;
  /** Custom skills shipped inside the package. Empty for a package that declares none. */
  skillBundles: SkillBundle[];
  /**
   * A non-fatal parse note, in the parser's words.
   *
   * Separate from `reason`: a warning accompanies a package that *was* read, and suppressing it
   * would hide a partial read behind a successful-looking selection.
   */
  warning?: string;
}

export interface DeclarativeAgentDetectionResult {
  agent?: DetectedDeclarativeAgent;
  /** Why nothing reviewable was found. Set only when `agent` is absent. */
  reason?: string;
}

const NOT_A_PACKAGE =
  'That file is not a declarative agent package. Upload the .zip exported from Microsoft 365 '
  + 'Copilot, which contains a manifest.json declaring a declarative agent.';

/**
 * Decide whether an upload is a declarative agent package, and read it if so.
 *
 * Takes the `File` rather than this engine's `UploadedArtifact` because ART's parser does, and
 * because the two want different things from the bytes: `UploadedArtifact` is a flat file list with
 * a content hash, while `parseDAZip` resolves the manifest's internal references to find the
 * declarative agent and its plugins. Re-deriving one from the other would be a second
 * implementation of the archive format, which is the thing this seam exists to avoid.
 */
export async function detectDeclarativeAgent(file: File): Promise<DeclarativeAgentDetectionResult> {
  let zipType: ZipType;
  try {
    zipType = await detectZipType(file);
  } catch {
    // The type test throws only on an archive it cannot open at all. That is a rejected upload like
    // any other — the reader stays on the file and the reason, rather than seeing a crash.
    return { reason: 'That file could not be read as a .zip archive.' };
  }

  if (zipType !== 'declarative-agent') {
    return { reason: NOT_A_PACKAGE };
  }

  try {
    const { manifest, packageEvidence, skillBundles, warning } = await parseDAZip(file);
    return {
      agent: {
        subjectId: await getDAIdentifier(manifest),
        displayName: manifest.name,
        manifest,
        packageEvidence,
        skillBundles,
        ...(warning ? { warning } : {}),
      },
    };
  } catch (error) {
    // The type test passed, so this archive *claims* to be a declarative agent and failed to parse.
    // The parser's own sentence names the field it could not resolve, which is what tells the
    // author how to fix the package — so it is shown verbatim rather than replaced.
    return { reason: error instanceof Error ? error.message : NOT_A_PACKAGE };
  }
}
