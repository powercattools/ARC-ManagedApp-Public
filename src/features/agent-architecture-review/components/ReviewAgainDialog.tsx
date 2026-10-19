/**
 * "Review the agent again" (Figma 8673:14514).
 *
 * Re-reviewing asks for the transcript window again rather than reusing the last one, because the reason
 * to take a new snapshot is usually to look at a different period. The window is stored on the snapshot
 * it produced, so an older snapshot keeps reporting the range it actually measured.
 */

import { useCallback, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { TranscriptRangeField } from './TranscriptRangeField';
import { ArtifactUploadField } from './ArtifactUploadField';
import { EMPTY_SELECTION, type ArtifactSelection } from './artifact-upload-rules';
import { calendarDay, isSchedulableRange } from '../services/snapshot-orchestration';
import type { ReviewAgainInput } from '../models/review';

const useStyles = makeStyles({
  content: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  muted: { color: tokens.colorNeutralForeground2 },
});

export interface ReviewAgainDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId?: string;
  /** DA/Skill reviews grade an uploaded artifact, so a new upload is asked for instead of a range. */
  needsUpload: boolean;
  /** What the previous snapshot graded, so a different upload can be called out before it runs. */
  priorSubjectId?: string;
  priorSubjectName?: string;
  isRunning: boolean;
  error?: string;
  savedSnapshotNumber?: number;
  onRun: (input: ReviewAgainInput) => void;
}

export function ReviewAgainDialog({
  open,
  onOpenChange,
  agentId,
  needsUpload,
  priorSubjectId,
  priorSubjectName,
  isRunning,
  error,
  savedSnapshotNumber,
  onRun,
}: ReviewAgainDialogProps) {
  const styles = useStyles();
  const [startDate, setStartDate] = useState<Date | null>(null);
  const [endDate, setEndDate] = useState<Date | null>(null);
  const [selection, setSelection] = useState<ArtifactSelection>(EMPTY_SELECTION);
  const [uploadKey, setUploadKey] = useState(0);

  /**
   * Cleared on close rather than in an effect watching `open`.
   *
   * Every way of dismissing the dialog — Cancel, Escape, clicking away — routes through here, so this is
   * the one place that reliably runs, and it avoids a render pass that exists only to undo state.
   */
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && isRunning) return;
      if (!next) {
        setStartDate(null);
        setEndDate(null);
        setSelection(EMPTY_SELECTION);
        setUploadKey((key) => key + 1);
      }
      onOpenChange(next);
    },
    [isRunning, onOpenChange],
  );

  /**
   * Retrying a saved snapshot re-schedules the inputs it was frozen with, so the fields above are
   * disabled and have nothing to say about it — the button stays live regardless of what they hold.
   *
   * Otherwise the range is required input, and the engine rejects anything but a strictly increasing
   * pair of UTC calendar days. Gating here is what keeps that rejection from arriving as a validator
   * sentence on screen after the user has already committed to the run.
   */
  const retryingSaved = savedSnapshotNumber !== undefined;
  const canRun = retryingSaved ? true : needsUpload ? selection.ready : isSchedulableRange(startDate, endDate);

  const handleRun = useCallback(() => {
    if (!canRun) return;
    onRun({
      artifactFileName: needsUpload ? selection.file?.name : undefined,
      ...(needsUpload && selection.declarativeAgent && selection.file
        ? { declarativeAgent: selection.file }
        : needsUpload && selection.artifact
          ? { artifact: selection.artifact, runtimes: selection.runtimes }
          : {}),
      transcriptStart: calendarDay(startDate),
      transcriptEnd: calendarDay(endDate),
    });
  }, [canRun, endDate, needsUpload, onRun, selection, startDate]);

  return (
    <Dialog open={open} onOpenChange={(_, data) => handleOpenChange(data.open)}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{needsUpload ? 'Review the artifact again' : 'Review the agent again'}</DialogTitle>
          <DialogContent className={styles.content}>
            {needsUpload ? (
              <>
                {/*
                  There is no environment to re-read from, so a new upload is always required
                  (FR-113). Nothing is inherited: the runtimes are asked again because a skill may
                  have been rewritten for a different one since.
                */}
                <Text className={styles.muted} size={200}>
                  Upload the artifact again. This creates a new snapshot; the previous one and its
                  file are kept unchanged.
                </Text>
                <ArtifactUploadField
                  key={uploadKey}
                  disabled={isRunning || savedSnapshotNumber !== undefined}
                  priorSubjectId={priorSubjectId}
                  priorSubjectName={priorSubjectName}
                  onChange={setSelection}
                />
              </>
            ) : (
              <TranscriptRangeField
                agentId={agentId}
                startDate={startDate}
                endDate={endDate}
                onStartDateChange={setStartDate}
                onEndDateChange={setEndDate}
                disabled={isRunning || savedSnapshotNumber !== undefined}
              />
            )}

            {!needsUpload && !startDate && !endDate ? (
              <Text className={styles.muted} size={200}>
                Choose an explicit start and later end date (inclusive UTC calendar days). This
                creates a new snapshot; earlier evidence is unchanged.
              </Text>
            ) : null}

            {error ? (
              <MessageBar intent="error">
                <MessageBarBody>{error}</MessageBarBody>
              </MessageBar>
            ) : null}
            {savedSnapshotNumber !== undefined ? <Text>
              Snapshot #{savedSnapshotNumber} is saved. Retry schedules its original inputs.
              Closing this dialog leaves it in history, where scheduling can be resumed.
            </Text> : null}
          </DialogContent>
          <DialogActions>
            <Button appearance="primary" disabled={!canRun || isRunning} onClick={handleRun}>
              {savedSnapshotNumber !== undefined ? 'Retry scheduling saved snapshot' : 'Run'}
            </Button>
            <Button appearance="secondary" disabled={isRunning} onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
