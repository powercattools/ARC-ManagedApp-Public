/**
 * The artifact drop zone and the runtime checkboxes, shared by the two dialogs that upload one.
 *
 * Shared rather than copied because both dialogs must accept and refuse exactly the same files. A
 * first review and a re-review that disagreed about what is reviewable would let a skill into a
 * series it could not have started, and the divergence would only show up as a snapshot nobody can
 * explain.
 *
 * The component owns reading, detection and the runtime choice, and reports a single selection
 * upward. Nothing is inherited from a previous snapshot: a skill may have been rewritten for a
 * different runtime since, so carrying the old answer forward would silently judge it against the
 * wrong catalogue (`harness-skill.md` §6.2).
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  Field,
  MessageBar,
  MessageBarBody,
  Spinner,
  Text,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { ArrowUploadRegular, DocumentRegular, DismissRegular } from '@fluentui/react-icons';
import {
  RUNTIME_LABELS,
  TARGET_RUNTIMES,
  describeRuntimeCoverage,
  describeUnsupportedUpload,
  readUploadedArtifact,
  reconcileRuntimes,
  runtimesForFile,
  type TargetRuntime,
  type UploadedArtifact,
} from '../engine/scoring/art-ports';
import { detectSkills } from '../engine/harnesses/skill/skill-detection';
import {
  ACCEPTED_EXTENSIONS,
  MAX_UPLOAD_BYTES,
  hasAcceptedExtension,
  isSelectionReady,
  type ArtifactSelection,
} from './artifact-upload-rules';
import {
  detectDeclarativeAgent,
  type DetectedDeclarativeAgent,
} from '../engine/harnesses/declarative-agent/da-detection';

export interface ArtifactUploadFieldProps {
  disabled?: boolean;
  /**
   * Which kind of upload this field is collecting.
   *
   * Optional, and skill is the default, because two of the three callers are the skill resume and
   * re-review paths — they hand the selection straight to `scheduleUploadSnapshot`, which takes an
   * `UploadedArtifact`. Leaving them on the default is what keeps a declarative agent from reaching
   * a path that has no way to review one.
   */
  assetType?: 'skill' | 'declarative-agent';
  /**
   * The subject the previous snapshot graded, when this is a re-review.
   *
   * Compared by name and nothing else — no content diff, no similarity score, no AI call. A
   * re-review exists because the content changed, so a difference proves nothing (§6.2).
   */
  priorSubjectId?: string;
  priorSubjectName?: string;
  onChange: (selection: ArtifactSelection) => void;
}

const useStyles = makeStyles({
  dropzone: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingVerticalS,
    padding: tokens.spacingVerticalXXL,
    border: `1px dashed ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    cursor: 'pointer',
    textAlign: 'center',
  },
  dropzoneActive: {
    border: `1px dashed ${tokens.colorBrandStroke1}`,
    backgroundColor: tokens.colorBrandBackground2,
  },
  dropzoneIcon: { fontSize: '28px', color: tokens.colorNeutralForeground3 },
  hint: { color: tokens.colorNeutralForeground3 },
  runtimeList: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  runtimeRow: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  selectedFile: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    padding: tokens.spacingVerticalS,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  fileName: { flexGrow: 1, textAlign: 'left' },
  hiddenInput: { display: 'none' },
});

export function ArtifactUploadField({
  disabled = false,
  assetType = 'skill',
  priorSubjectId,
  priorSubjectName,
  onChange,
}: ArtifactUploadFieldProps) {
  const styles = useStyles();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [artifact, setArtifact] = useState<UploadedArtifact | null>(null);
  const [declarativeAgent, setDeclarativeAgent] = useState<DetectedDeclarativeAgent | null>(null);
  const [detectedNames, setDetectedNames] = useState<string[]>([]);
  const [subjectIds, setSubjectIds] = useState<string[]>([]);
  const [runtimes, setRuntimes] = useState<TargetRuntime[]>([]);
  const [reading, setReading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const publish = useCallback(
    (next: Partial<ArtifactSelection>) => {
      const merged: ArtifactSelection = {
        file,
        artifact,
        declarativeAgent,
        runtimes,
        detectedNames,
        subjectIds,
        ready: false,
        ...next,
      };
      onChange({ ...merged, ready: isSelectionReady(merged) });
    },
    [artifact, declarativeAgent, detectedNames, file, onChange, runtimes, subjectIds],
  );

  /**
   * Take a chosen file, read it, and decide whether it holds anything reviewable.
   *
   * The decision is made here rather than at submit because a file that cannot be reviewed should
   * never produce a snapshot: the row would exist only to record that nothing was found. The
   * detector's own sentence is shown verbatim — it names what was looked for, which is what tells
   * the reader how to fix the bundle.
   */
  const acceptFile = useCallback(
    async (candidate: File) => {
      if (!hasAcceptedExtension(candidate.name)) {
        setUploadError(`Unsupported file type. Accepted formats: ${ACCEPTED_EXTENSIONS.join(', ')}.`);
        return;
      }
      if (candidate.size > MAX_UPLOAD_BYTES) {
        setUploadError('That file is larger than 16 MB. Upload a smaller artifact.');
        return;
      }

      setUploadError(null);
      setUploadWarning(null);
      setFile(candidate);
      setArtifact(null);
      setDeclarativeAgent(null);
      setDetectedNames([]);
      setSubjectIds([]);
      setReading(true);
      publish({ file: candidate, artifact: null, declarativeAgent: null, detectedNames: [], subjectIds: [] });

      // A declarative agent is read by its own detector, against the same file. The two are
      // siblings rather than a fallback chain: trying skill detection first and DA second would
      // report a skill's reason for a DA package, which names the wrong thing to fix.
      if (assetType === 'declarative-agent') {
        try {
          const detected = await detectDeclarativeAgent(candidate);
          if (!detected.agent) {
            setUploadError(detected.reason ?? 'No declarative agent was found in that file.');
            return;
          }
          const names = [detected.agent.displayName];
          const ids = [detected.agent.subjectId];
          setDeclarativeAgent(detected.agent);
          setDetectedNames(names);
          setSubjectIds(ids);
          setUploadWarning(detected.agent.warning ?? null);
          publish({ file: candidate, declarativeAgent: detected.agent, detectedNames: names, subjectIds: ids });
        } finally {
          setReading(false);
        }
        return;
      }

      try {
        const read = await readUploadedArtifact(candidate);
        const detected = detectSkills(read);
        if (detected.skills.length === 0) {
          setUploadError(detected.reason ?? 'No reviewable artifact was found in that file.');
          return;
        }
        const names = detected.skills.map((skill) => skill.identity.displayName);
        const ids = detected.skills.map((skill) => skill.identity.subjectId);
        // Reconcile against the file just chosen, so the order of the two decisions does not
        // matter. The rule itself is ART's, and lives beside the reasoning for it.
        const nextRuntimes = reconcileRuntimes(runtimes, runtimesForFile(candidate));
        setArtifact(read);
        setDetectedNames(names);
        setSubjectIds(ids);
        setRuntimes(nextRuntimes);
        publish({ file: candidate, artifact: read, detectedNames: names, subjectIds: ids, runtimes: nextRuntimes });
      } catch (error) {
        // A malformed archive throws out of the reader. That is a rejected upload like any other,
        // not a crash: the file stays on screen with the reason beside it.
        setUploadError(error instanceof Error ? error.message : 'That file could not be read.');
      } finally {
        setReading(false);
      }
    },
    [assetType, publish, runtimes],
  );

  const toggleRuntime = useCallback(
    (runtime: TargetRuntime, checked: boolean) => {
      const next = checked
        ? [...runtimes, runtime].filter((value, index, all) => all.indexOf(value) === index)
        : runtimes.filter((value) => value !== runtime);
      setRuntimes(next);
      publish({ runtimes: next });
    },
    [publish, runtimes],
  );

  const clear = useCallback(() => {
    setFile(null);
    setArtifact(null);
    setDeclarativeAgent(null);
    setDetectedNames([]);
    setSubjectIds([]);
    setUploadError(null);
    setUploadWarning(null);
    publish({ file: null, artifact: null, declarativeAgent: null, detectedNames: [], subjectIds: [] });
  }, [publish]);

  /** Recomputed per render, so the boxes settle the moment a file lands or is replaced. */
  const allowedRuntimes = useMemo(() => runtimesForFile(file), [file]);

  /**
   * Whether this upload looks like a different skill from the one the series has been grading.
   *
   * A signal, not a verdict, and it never blocks: the skill is graded on its own merits either way.
   */
  const subjectChanged =
    Boolean(priorSubjectId) && subjectIds.length > 0 && !subjectIds.includes(priorSubjectId!);

  return (
    <>
      <Field label="Upload">
        <div>
          <input
            ref={fileInputRef}
            type="file"
            disabled={disabled}
            accept={ACCEPTED_EXTENSIONS.join(',')}
            className={styles.hiddenInput}
            onChange={(event) => {
              const chosen = event.target.files?.[0];
              event.target.value = '';
              if (chosen) void acceptFile(chosen);
            }}
          />
          {file ? (
            <div className={styles.selectedFile}>
              <DocumentRegular />
              <Text className={styles.fileName}>{file.name}</Text>
              <Button
                appearance="subtle"
                icon={<DismissRegular />}
                aria-label="Remove file"
                disabled={disabled}
                onClick={clear}
              />
            </div>
          ) : (
            <div
              className={mergeClasses(styles.dropzone, isDragging && styles.dropzoneActive)}
              role="button"
              inert={disabled}
              tabIndex={0}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setIsDragging(false);
                const dropped = event.dataTransfer.files?.[0];
                if (dropped) void acceptFile(dropped);
              }}
            >
              <ArrowUploadRegular className={styles.dropzoneIcon} />
              <Text>Drop a file here or</Text>
              <Button appearance="secondary">Browse files</Button>
              <Text size={200} className={styles.hint}>
                Accepts {ACCEPTED_EXTENSIONS.join(', ')} up to 16 MB
              </Text>
            </div>
          )}
        </div>
      </Field>

      {/*
        The runtime choice is a form field because it cannot be anything else: a SKILL.md carries no
        marker naming the platform it was written for, so picking one on the author's behalf would
        silently choose a rubric. Ticking more than one shows where the skill is portable.
      */}
      {reading ? (
        <Spinner size="tiny" label="Reading the file" labelPosition="after" />
      ) : artifact ? (
        <Field label="Target runtimes">
          <div className={styles.runtimeList}>
            {TARGET_RUNTIMES.map((runtime) => {
              const supported = allowedRuntimes.includes(runtime);
              return (
                <div key={runtime} className={styles.runtimeRow}>
                  <Checkbox
                    checked={runtimes.includes(runtime)}
                    disabled={!supported || disabled}
                    label={RUNTIME_LABELS[runtime]}
                    onChange={(_, data) => toggleRuntime(runtime, data.checked === true)}
                  />
                  {/* A disabled control that gives no reason reads as a bug. */}
                  <Text size={200} className={styles.hint}>
                    {supported
                      ? describeRuntimeCoverage(runtime)
                      : describeUnsupportedUpload(runtime, 'automation')}
                  </Text>
                </div>
              );
            })}
          </div>
        </Field>
      ) : null}

      {subjectChanged ? (
        <MessageBar intent="warning">
          <MessageBarBody>
            This upload is named “{detectedNames[0]}”. The previous snapshot reviewed “
            {priorSubjectName ?? priorSubjectId}”. It may not be the same skill, so this snapshot
            will be graded on its own and no trend will be shown against the one before it.
          </MessageBarBody>
        </MessageBar>
      ) : null}

      {(artifact || declarativeAgent) && detectedNames.length > 0 ? (
        <Text size={200} className={styles.hint}>
          {detectedNames.length === 1
            ? `Will review “${detectedNames[0]}”.`
            : `Will review ${detectedNames.length} artifacts: ${detectedNames.join(', ')}.`}
        </Text>
      ) : null}

      {/*
        A warning accompanies a package that *was* read. It is shown beside the accepted upload
        rather than in place of it, because the review can still run — hiding it would let a
        partial read look like a clean one.
      */}
      {uploadWarning ? (
        <MessageBar intent="warning">
          <MessageBarBody>{uploadWarning}</MessageBarBody>
        </MessageBar>
      ) : null}

      {uploadError ? (
        <MessageBar intent="error">
          <MessageBarBody>{uploadError}</MessageBarBody>
        </MessageBar>
      ) : null}
    </>
  );
}
