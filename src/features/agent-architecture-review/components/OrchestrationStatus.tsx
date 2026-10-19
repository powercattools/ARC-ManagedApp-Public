import { useEffect, useState } from 'react';
import {
  Button, Caption1, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  MessageBar, MessageBarBody, makeStyles, tokens,
} from '@fluentui/react-components';
import {
  assessmentTerminal, orchestrationPhase, useIsDrivingSnapshot, useOrchestration,
  useResumeUploadSnapshot, useScheduleSnapshot, PHASE_PROMISE,
} from '../hooks/use-orchestration';
import { ArtifactUploadField } from './ArtifactUploadField';
import { EMPTY_SELECTION, type ArtifactSelection } from './artifact-upload-rules';
import { isUploadAssetType, type Review, type ReviewResult } from '../models/review';

const useStyles = makeStyles({
  action: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    flexWrap: 'wrap',
  },
});

/**
 * Asks for the artifact again so a saved upload snapshot can finish.
 *
 * An upload cannot be retried the way an agent snapshot can: the bytes were never persisted, so
 * there is nothing to read back and the file has to be chosen a second time. What makes this a
 * resume rather than a repeat is the snapshot it targets — a skill whose job already finished is
 * re-attached to it instead of being reviewed, and paid for, twice.
 */
function ResumeUploadButton({ result, onSaved }: { result: ReviewResult; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<ArtifactSelection>(EMPTY_SELECTION);
  const resume = useResumeUploadSnapshot(result, () => {
    setOpen(false);
    setSelection(EMPTY_SELECTION);
    onSaved();
  });

  return (
    <>
      <Button disabled={resume.isPending} onClick={() => setOpen(true)}>
        {resume.isPending ? 'Resuming saved snapshot...' : 'Upload the file again to resume'}
      </Button>
      {resume.error ? <p>{resume.error.message}</p> : null}
      <Dialog open={open} onOpenChange={(_, data) => setOpen(data.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Resume snapshot #{result.sequenceNumber}</DialogTitle>
            <DialogContent>
              <p>
                This snapshot is saved but its review never finished. Upload the same file again to
                complete it. Work that already finished is reused rather than run again.
              </p>
              <ArtifactUploadField disabled={resume.isPending} onChange={setSelection} />
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" disabled={resume.isPending} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                disabled={!selection.ready || resume.isPending}
                onClick={() => {
                  if (selection.declarativeAgent && selection.file) {
                    resume.mutate({ declarativeAgent: selection.file, runtimes: [] });
                    return;
                  }
                  if (!selection.artifact) return;
                  resume.mutate({ artifact: selection.artifact, runtimes: selection.runtimes });
                }}
              >
                {resume.isPending ? 'Resuming...' : 'Resume'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

/**
 * The snapshot's orchestration, reported to the console rather than to the reader.
 *
 * The plan, its assessments and its timings are debugging material: they describe how the review was
 * produced, not what it found. On screen they were noise — a banner that appeared while a snapshot
 * loaded, again while it re-ran, and once more to announce that nothing had gone wrong — so they now
 * go to devtools, where they can be read when something needs explaining.
 *
 * What stays on screen is only what the reader cannot act without: a snapshot that was never
 * scheduled, one left unfinished by a tab that closed, and a failure that would otherwise leave the
 * results below looking simply thin rather than incomplete.
 */
export function OrchestrationStatus({ review, result }: { review: Review; result: ReviewResult }) {
  const styles = useStyles();
  const query = useOrchestration(result);
  const schedule = useScheduleSnapshot(review, result, () => { void query.refetch(); });
  const driving = useIsDrivingSnapshot(result.id);
  const progress = query.data?.progress;
  const finished = progress?.assessments.filter(assessmentTerminal).length ?? 0;
  const total = progress?.assessments.length ?? 0;
  const phase = orchestrationPhase(progress, query.isPending);
  const failed = phase === 'stopped';
  const needsArtifact = isUploadAssetType(review.assetType);
  const error = query.error ?? schedule.error ?? undefined;

  useEffect(() => {
    if (query.isPending) return;
    console.info('[ARW] snapshot orchestration', {
      snapshot: result.id,
      sequenceNumber: result.sequenceNumber,
      phase,
      status: progress?.status ?? 'not scheduled',
      settled: `${finished} of ${total}`,
      lastRecordedActivity: progress?.updatedOn,
      assessments: progress?.assessments,
      gaps: progress?.gaps,
      error: progress?.error ?? error?.message,
    });
  }, [query.isPending, result.id, result.sequenceNumber, phase, progress, finished, total, error]);

  if (phase === 'not-scheduled') {
    return (
      <div className={styles.action}>
        <Caption1>{PHASE_PROMISE['not-scheduled']}</Caption1>
        {needsArtifact
          ? <ResumeUploadButton result={result} onSaved={() => { void query.refetch(); }} />
          : <Button disabled={schedule.isPending} onClick={() => schedule.mutate()}>
              {schedule.isPending ? 'Scheduling saved snapshot...' : 'Retry scheduling this saved snapshot'}
            </Button>}
        {error ? <Caption1>{error.message}</Caption1> : null}
      </div>
    );
  }

  // A stopped run explains why what follows is thin; without it the results read as merely poor.
  if (failed || phase === 'needs-attention' || query.isError) {
    return (
      <MessageBar intent={phase === 'needs-attention' ? 'warning' : 'error'}>
        <MessageBarBody>
          {progress?.error ?? error?.message ?? PHASE_PROMISE[phase]}
        </MessageBarBody>
      </MessageBar>
    );
  }

  // A run nobody is driving. Until now this fell through to `null`, so a snapshot abandoned when a
  // tab closed sat on the results page showing nothing at all — while `PHASE_PROMISE` told the user
  // in so many words to reopen it to finish it, with no way to do so.
  if (phase === 'in-progress') {
    const settled = total > 0 ? `${finished} of ${total} assessments settled. ` : '';
    if (driving) {
      return (
        <div className={styles.action}>
          <Caption1>
            {settled}This review is running in this tab. Leaving the page does not stop the work
            already sent to the server, but assembling the review happens here.
          </Caption1>
        </div>
      );
    }
    return (
      <div className={styles.action}>
        <Caption1>{settled}{PHASE_PROMISE['in-progress']}</Caption1>
        {needsArtifact
          ? <ResumeUploadButton result={result} onSaved={() => { void query.refetch(); }} />
          : <Button disabled={schedule.isPending} onClick={() => schedule.mutate()}>
              {schedule.isPending ? 'Resuming...' : 'Resume this snapshot'}
            </Button>}
        {error ? <Caption1>{error.message}</Caption1> : null}
      </div>
    );
  }

  return null;
}
