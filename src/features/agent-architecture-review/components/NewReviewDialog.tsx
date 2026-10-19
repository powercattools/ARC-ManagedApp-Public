/**
 * "New review" dialog (Figma 8647:28543 and 8650:33139).
 *
 * Two variants share one shell, selected by the asset-type tabs:
 *   - Copilot Studio Agent -> environment + agent pickers and a transcript date range
 *   - Declarative Agent / Skill -> an artifact upload dropzone
 */

import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Button,
  Combobox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  InfoLabel,
  Input,
  MessageBar,
  MessageBarActions,
  MessageBarBody,
  MessageBarTitle,
  Option,
  Spinner,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  Agents16Filled,
  Braces16Filled,
  DismissRegular,
  Script16Filled,
  Search16Regular,
} from '@fluentui/react-icons';
import { useAgents, useCreateReview, useEnvironments } from '../hooks/use-reviews';
import { useArtLinkContext } from '../hooks/use-art';
import { CURRENT_ORGANIZATION, isSameOrganization } from '../services/art-service';
import { calendarDay, defaultTranscriptRange, isSchedulableRange } from '../services/snapshot-orchestration';
import { TranscriptRangeField } from './TranscriptRangeField';
import { SnapshotProgressDialog } from './SnapshotProgressDialog';
import type { SnapshotProgress } from '../engine/contracts/review-progress';
import { ASSET_TYPE_LABELS, isUploadAssetType, type AssetType, type CreatedReview } from '../models/review';
import { logReviewAction } from '../services/review-telemetry';
import { ArtifactUploadField } from './ArtifactUploadField';
import { EMPTY_SELECTION, type ArtifactSelection } from './artifact-upload-rules';

/**
 * Sentinel for "no environment chosen yet".
 *
 * The Figma dialog defaults this field to "All environments", which implies a
 * cross-organization agent search. That fan-out is explicitly out of Phase 1
 * (OQ-31), and without it an "All environments" default would show an empty
 * agent list — so the field starts unset and asks the user to choose.
 */
const NO_ENVIRONMENT = '';

const useStyles = makeStyles({
  surface: { maxWidth: '614px' },
  /**
   * The backgrounded run, pinned above the page it let the user get back to.
   *
   * Fixed rather than placed in the page because the run does not belong to any one route — the user
   * backgrounded it precisely so they could navigate — and a Fluent toast is the wrong shape: this
   * has no timeout and has to survive until the run ends.
   */
  backgroundBar: {
    position: 'fixed',
    right: '24px',
    bottom: '24px',
    zIndex: 1_000_000,
    maxWidth: '420px',
    boxShadow: tokens.shadow16,
  },
  // Agent lists run to hundreds of rows; without a bound the popup grows past
  // the dialog and is repositioned to the viewport edge.
  listbox: { maxHeight: '260px' },
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  /**
   * Stands in for `Field` where a label carries an info button, or covers more
   * than one control. `Field` points the control's `aria-labelledby` at the whole
   * label, which swallows the info button ("Project name information") and gives
   * both date pickers the same name. Labelling each control directly avoids that.
   */
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
  },
  /**
   * Asset-type picker. The design calls this "TabList-elevated" but renders a
   * segmented control: a tinted track with the selected segment lifted onto a
   * white, shadowed card.
   */
  segmented: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0px',
    padding: '2px',
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    width: 'fit-content',
  },
  segment: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacingHorizontalSNudge,
    height: '30px',
    paddingLeft: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalM,
    border: 'none',
    borderRadius: tokens.borderRadiusSmall,
    backgroundColor: 'transparent',
    color: tokens.colorNeutralForeground2,
    fontFamily: tokens.fontFamilyBase,
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
    lineHeight: tokens.lineHeightBase300,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    ':hover': { color: tokens.colorNeutralForeground1 },
  },
  segmentSelected: {
    backgroundColor: tokens.colorNeutralBackground1,
    color: tokens.colorNeutralForeground1,
    boxShadow: tokens.shadow2,
  },
  /** The design sizes the pickers to 417px inside a 550px content column. */
  control: { maxWidth: '417px' },
  /** Agent picker: leading magnifier, with the chevron left in place. */
  searchField: { position: 'relative', display: 'flex', maxWidth: '417px' },
  searchIcon: {
    position: 'absolute',
    left: tokens.spacingHorizontalSNudge,
    top: '50%',
    transform: 'translateY(-50%)',
    color: tokens.colorNeutralForeground3,
    pointerEvents: 'none',
    zIndex: 1,
  },
  searchCombobox: {
    width: '100%',
    minWidth: 'unset',
    '& input': { paddingLeft: tokens.spacingHorizontalXXL },
  },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: tokens.spacingHorizontalS,
  },
  dropzoneIcon: { fontSize: '28px', color: tokens.colorNeutralForeground3 },
  hint: { color: tokens.colorNeutralForeground3 },
});

/** Asset types in design order, each with the icon the design pairs it with. */
const ASSET_SEGMENTS: { type: AssetType; icon: ReactNode }[] = [
  { type: 'copilot-studio-agent', icon: <Agents16Filled /> },
  { type: 'declarative-agent', icon: <Braces16Filled /> },
  { type: 'skill', icon: <Script16Filled /> },
];

function formatTimestamp(date: Date): string {
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })}`;
}

/** "Agent Review 8/18/2026 1:42 PM" / "Skill Review …" — the Figma pre-fill. */
function defaultName(assetType: AssetType): string {
  const prefix = assetType === 'skill' ? 'Skill Review' : 'Agent Review';
  return `${prefix} ${formatTimestamp(new Date())}`;
}

/** Short locale date, so the pickers don't render JS's default `Fri Aug 14 2026`. */

/** How far a backgrounded run has got, in the one line the bar has room for. */
function backgroundDetail(progress: SnapshotProgress | undefined): string {
  const agents = progress?.agents ?? [];
  if (agents.length === 0) return 'Reading agent configuration';
  const done = agents.filter((agent) => agent.outcome === 'succeeded' || agent.outcome === 'failed').length;
  return `${done} of ${agents.length} ${agents.length === 1 ? 'agent' : 'agents'} reviewed`;
}

/**
 * A run that is still going somewhere behind the page.
 *
 * Deliberately not a toast. Toasts expire, and this has to hold for as long as the run does; the one
 * Toaster in this app is mounted per-component anyway, so there is nothing here to post into.
 */
function BackgroundRunBar({ className, intent = 'info', label, detail, action }: {
  className: string;
  intent?: 'info' | 'success' | 'warning';
  label: string;
  detail?: string;
  action: ReactNode;
}) {
  return (
    <MessageBar className={className} intent={intent} role="status">
      <MessageBarBody>
        <MessageBarTitle>{label}</MessageBarTitle>
        {detail ? ` ${detail}` : null}
      </MessageBarBody>
      <MessageBarActions>{action}</MessageBarActions>
    </MessageBar>
  );
}

export interface NewReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The saved review *and* its first snapshot.
   *
   * The whole pair rather than the review id, because creating a review now lands on the result it
   * produced. Handing back only the id would leave the caller to look up "the one I just made",
   * which is a race against the write that just happened.
   */
  onCreated: (created: CreatedReview, assetType: AssetType) => void;
}

export function NewReviewDialog({ open, onOpenChange, onCreated }: NewReviewDialogProps) {
  const styles = useStyles();

  const [assetType, setAssetType] = useState<AssetType>('copilot-studio-agent');
  const [name, setName] = useState(() => defaultName('copilot-studio-agent'));
  const [nameEdited, setNameEdited] = useState(false);
  /**
   * The environment the user chose, or `null` while they have not chosen one.
   *
   * Null is not the same as `NO_ENVIRONMENT`: it defers to the default below, whereas an explicit
   * empty string is the user clearing the field and stays cleared.
   */
  const [environmentChoice, setEnvironmentChoice] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string>('');
  /** Free text typed into the agent picker; drives client-side filtering. */
  const [agentQuery, setAgentQuery] = useState<string>('');
  const [startDate, setStartDate] = useState<Date | null>(() => defaultTranscriptRange().start);
  const [endDate, setEndDate] = useState<Date | null>(() => defaultTranscriptRange().end);
  /**
   * What the upload field currently holds.
   *
   * `artifact` is set only once the bytes were read and shown to hold something reviewable, which is
   * why Create is gated on it rather than on the file: a file the reader or the detector rejected
   * stays on screen so the reader can see which one failed, but creates no snapshot at all.
   */
  const [selection, setSelection] = useState<ArtifactSelection>(EMPTY_SELECTION);
  /** Bumped to remount the upload field, which is how its internal state is cleared. */
  const [uploadKey, setUploadKey] = useState(0);

  const isUpload = isUploadAssetType(assetType);

  const environments = useEnvironments();
  const createReview = useCreateReview();
  const inputsLocked = createReview.isPending || Boolean(createReview.savedSnapshot);

  /**
   * Whether the user sent this run to the background.
   *
   * Held in a ref as well as state because `onSuccess` closes over the values it was created with,
   * and backgrounding happens after the mutation starts — a captured value is always stale by the
   * time it decides whether finishing should yank the user to the result.
   */
  const backgroundedRef = useRef(false);
  const [backgrounded, setBackgrounded] = useState(false);
  const sendToBackground = useCallback(() => {
    backgroundedRef.current = true;
    setBackgrounded(true);
    onOpenChange(false);
  }, [onOpenChange]);

  /**
   * The environment to open on: the one this app is running in.
   *
   * It is where almost every review is created, and it is the only one runtime analysis can read —
   * so starting anywhere else costs the user a selection to reach the common case. Its real URL is
   * preferred over the `current` sentinel because that entry carries the friendly name; the sentinel
   * is the fallback for when `GetOrganizations` does not list the environment by URL as well.
   */
  const linkContext = useArtLinkContext();
  const defaultEnvironmentUrl = useMemo(() => {
    const all = environments.data ?? [];
    const named = all.find((environment) =>
      isSameOrganization(environment.url, linkContext.data?.organizationUrl));
    const sentinel = all.find((environment) => environment.url.toLowerCase() === CURRENT_ORGANIZATION);
    return (named ?? sentinel)?.url;
  }, [environments.data, linkContext.data?.organizationUrl]);

  /**
   * Derived rather than stored, so the default can appear the moment the two reads land without ever
   * overwriting a choice already made: from the first selection the state is non-null and wins.
   */
  const environmentUrl = environmentChoice ?? defaultEnvironmentUrl ?? NO_ENVIRONMENT;
  const selectedEnvironmentUrl = environmentUrl === NO_ENVIRONMENT ? undefined : environmentUrl;

  const agents = useAgents(selectedEnvironmentUrl);

  const selectedAgent = useMemo(
    () => agents.data?.find((agent) => agent.botId === agentId),
    [agents.data, agentId],
  );
  const selectedEnvironment = useMemo(
    () => environments.data?.find((environment) => environment.url === environmentUrl),
    [environments.data, environmentUrl],
  );

  /**
   * An environment can hold hundreds of agents, and Fluent's Combobox does not
   * filter its own options — so narrow them here, the way the Agent Review Tool
   * narrows its environment list.
   */
  const visibleAgents = useMemo(() => {
    const all = agents.data ?? [];
    const query = agentQuery.trim().toLowerCase();
    if (!query || query === selectedAgent?.name.toLowerCase()) return all;
    return all.filter((agent) => agent.name.toLowerCase().includes(query));
  }, [agents.data, agentQuery, selectedAgent]);

  const reset = useCallback(() => {
    setAssetType('copilot-studio-agent');
    setName(defaultName('copilot-studio-agent'));
    setNameEdited(false);
    setEnvironmentChoice(null);
    setAgentId('');
    setAgentQuery('');
    setStartDate(defaultTranscriptRange().start);
    setEndDate(defaultTranscriptRange().end);
    setSelection(EMPTY_SELECTION);
    setUploadKey((key) => key + 1);
    backgroundedRef.current = false;
    setBackgrounded(false);
    createReview.reset();
  }, [createReview]);

  const close = useCallback(() => {
    if (createReview.isPending) return;
    reset();
    onOpenChange(false);
  }, [createReview.isPending, onOpenChange, reset]);

  const handleAssetTypeChange = useCallback(
    (next: AssetType) => {
      setAssetType(next);
      setAgentId('');
      setAgentQuery('');
      setSelection(EMPTY_SELECTION);
      setUploadKey((key) => key + 1);
      // Keep a name the user has deliberately typed; otherwise track the tab.
      if (!nameEdited) setName(defaultName(next));
    },
    [nameEdited],
  );

  const rangeReady = useMemo(
    () => isUpload || isSchedulableRange(startDate, endDate),
    [isUpload, startDate, endDate],
  );

  const canCreate =
    (Boolean(createReview.savedSnapshot)
      || (name.trim().length > 0
        && (isUpload
          // An upload is ready only once its bytes have been read and shown to hold something
          // reviewable, and a runtime has been chosen to judge it against.
          ? selection.ready
          : Boolean(agentId) && rangeReady)))
    && !createReview.isPending;

  const handleCreate = useCallback(() => {
    if (!canCreate) return;
    // Report the accepted Create to telemetry, but never for a saved-snapshot retry (no new review
    // is being started). Fire-and-forget: the call can never block or fail the create.
    if (!createReview.savedSnapshot) {
      logReviewAction('create', assetType, null);
    }
    createReview.mutate(
      {
        projectName: name.trim(),
        assetType,
        environmentUrl: selectedEnvironmentUrl,
        environmentName: selectedEnvironment?.friendlyName,
        botId: agentId || undefined,
        botName: selectedAgent?.name,
        transcriptStart: calendarDay(startDate),
        transcriptEnd: calendarDay(endDate),
        artifactFileName: selection.file?.name,
        // The file rather than the parsed agent: the engine's detector owns the parse, exactly as
        // it does for a skill upload, so what the dialog previewed never becomes a second source of
        // truth the run has to be trusted to agree with.
        ...(selection.declarativeAgent && selection.file
          ? { declarativeAgent: selection.file }
          : selection.artifact
            ? { artifact: selection.artifact, runtimes: selection.runtimes }
            : {}),
      },
      {
        onSuccess: (created) => {
          // Backgrounding was a request to be left alone. Navigating to the result now would undo
          // exactly that, so the bar keeps the finished run in reach and the user decides when.
          if (backgroundedRef.current) return;
          reset();
          onOpenChange(false);
          onCreated(created, assetType);
        },
      },
    );
  }, [
    agentId,
    assetType,
    canCreate,
    createReview,
    endDate,
    name,
    onCreated,
    onOpenChange,
    reset,
    selection,
    selectedAgent,
    selectedEnvironment,
    selectedEnvironmentUrl,
    startDate,
  ]);

  // While an orchestrated snapshot runs, this dialog's own form has nothing left to offer and the
  // run is the only thing worth showing. `savedSnapshot` is set the moment the snapshot row exists,
  // which is also the moment the engine starts, so the two never overlap.
  //
  // `open` doubles as "is the user watching": backgrounding closes the dialog without touching the
  // mutation, and reopening puts the same run back on screen.
  if (createReview.savedSnapshot && createReview.isPending) {
    return open ? (
      <SnapshotProgressDialog
        open
        title={selectedAgent?.name ?? name.trim()}
        progress={createReview.progress}
        onBackground={sendToBackground}
      />
    ) : (
      <BackgroundRunBar
        className={styles.backgroundBar}
        label={`Reviewing ${selectedAgent?.name || name.trim() || 'this agent'}`}
        detail={backgroundDetail(createReview.progress)}
        action={<Button size="small" onClick={() => onOpenChange(true)}>Show progress</Button>}
      />
    );
  }

  // The run ended after the user walked away. Whether it worked or not, it is theirs to open when
  // they choose — the same reason finishing did not navigate.
  if (backgrounded && createReview.savedSnapshot && !open) {
    const finished = createReview.savedSnapshot;
    return (
      <BackgroundRunBar
        className={styles.backgroundBar}
        intent={createReview.error ? 'warning' : 'success'}
        label={createReview.error
          ? `Snapshot #${finished.result.sequenceNumber} did not finish`
          : `Snapshot #${finished.result.sequenceNumber} is ready`}
        detail={createReview.error
          ? 'It is saved, and can be resumed from the review.'
          : undefined}
        action={
          <>
            <Button size="small" appearance="primary" onClick={() => {
              reset();
              onCreated(finished, assetType);
            }}>Open results</Button>
            <Button size="small" onClick={reset}>Dismiss</Button>
          </>
        }
      />
    );
  }

  return (
    <Dialog open={open} onOpenChange={(_, data) => (data.open ? onOpenChange(true) : close())}>
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle
            action={
              <Button
                appearance="subtle"
                icon={<DismissRegular />}
                aria-label="Close"
                disabled={createReview.isPending}
                onClick={close}
              />
            }
          >
            New review
          </DialogTitle>
          <DialogContent className={styles.body}>
            <div className={styles.fieldGroup}>
              <InfoLabel info="Shown in the reviews list. Pre-filled with the asset type and the current date and time.">
                Project name
              </InfoLabel>
              <Input
                aria-label="Project name"
                disabled={inputsLocked}
                value={name}
                onChange={(_, data) => {
                  setName(data.value);
                  setNameEdited(true);
                }}
              />
            </div>

            <Field label="What kind of asset are you reviewing?">
              <div className={styles.segmented} role="tablist">
                {ASSET_SEGMENTS.map(({ type, icon }) => (
                  <button
                    key={type}
                    type="button"
                    disabled={inputsLocked}
                    role="tab"
                    aria-selected={assetType === type}
                    className={mergeClasses(
                      styles.segment,
                      assetType === type && styles.segmentSelected,
                    )}
                    onClick={() => handleAssetTypeChange(type)}
                  >
                    {icon}
                    {ASSET_TYPE_LABELS[type]}
                  </button>
                ))}
              </div>
            </Field>

            {isUpload ? (
              <ArtifactUploadField
                key={uploadKey}
                disabled={inputsLocked}
                assetType={assetType === 'declarative-agent' ? 'declarative-agent' : 'skill'}
                onChange={setSelection}
              />
            ) : (
              <>
                <Field label="Environments">
                  {environments.isPending ? (
                    <Spinner size="tiny" label="Loading environments" labelPosition="after" />
                  ) : environments.isError ? (
                    <MessageBar intent="error">
                      Could not load environments.
                      <MessageBarActions>
                        <Button size="small" onClick={() => void environments.refetch()}>
                          Retry
                        </Button>
                      </MessageBarActions>
                    </MessageBar>
                  ) : environments.data?.length === 0 ? (
                    <MessageBar intent="warning">
                      No environments found.
                    </MessageBar>
                  ) : (
                    <Combobox
                      className={styles.control}
                      placeholder="Select an environment"
                      disabled={inputsLocked}
                      value={selectedEnvironment?.friendlyName ?? ''}
                      selectedOptions={environmentUrl ? [environmentUrl] : []}
                      listbox={{ className: styles.listbox }}
                      positioning="below-start"
                      onOptionSelect={(_, data) => {
                        setEnvironmentChoice(data.optionValue ?? NO_ENVIRONMENT);
                        setAgentId('');
                        setAgentQuery('');
                      }}
                    >
                      {environments.data?.map((environment) => (
                        <Option
                          key={environment.url}
                          value={environment.url}
                          text={environment.friendlyName}
                        >
                          {environment.friendlyName}
                        </Option>
                      ))}
                    </Combobox>
                  )}
                </Field>

                <Field label="Choose agent">
                  {!selectedEnvironmentUrl ? (
                    <div className={styles.searchField}>
                      <Search16Regular className={styles.searchIcon} />
                      <Combobox
                        className={styles.searchCombobox}
                        aria-label="Choose agent"
                        placeholder="Select an environment first"
                        disabled
                      />
                    </div>
                  ) : agents.isPending ? (
                    <Spinner size="tiny" label="Loading agents" labelPosition="after" />
                  ) : agents.isError ? (
                    <MessageBar intent="error">
                      Could not load agents for this environment. You may not have access to it.
                      <MessageBarActions>
                        <Button size="small" onClick={() => void agents.refetch()}>
                          Retry
                        </Button>
                      </MessageBarActions>
                    </MessageBar>
                  ) : agents.data?.length === 0 ? (
                    <MessageBar intent="warning">No active agents in this environment.</MessageBar>
                  ) : (
                    <div className={styles.searchField}>
                      <Search16Regular className={styles.searchIcon} />
                      <Combobox
                        className={styles.searchCombobox}
                        aria-label="Choose agent"
                        placeholder="Search"
                        disabled={inputsLocked}
                        value={agentQuery}
                        selectedOptions={agentId ? [agentId] : []}
                        listbox={{ className: styles.listbox }}
                        positioning="below-start"
                        onChange={(event) => {
                          setAgentQuery(event.target.value);
                          setAgentId('');
                        }}
                        onOptionSelect={(_, data) => {
                          setAgentId(data.optionValue ?? '');
                          setAgentQuery(data.optionText ?? '');
                        }}
                      >
                        {visibleAgents.length === 0 ? (
                          <Option key="no-match" value="" text="" disabled>
                            No agents match “{agentQuery}”
                          </Option>
                        ) : (
                          visibleAgents.map((agent) => (
                            <Option key={agent.botId} value={agent.botId} text={agent.name}>
                              {agent.name}
                            </Option>
                          ))
                        )}
                      </Combobox>
                    </div>
                  )}
                </Field>

                <TranscriptRangeField
                  agentId={agentId || undefined}
                  environmentUrl={selectedEnvironmentUrl}
                  startDate={startDate}
                  endDate={endDate}
                  onStartDateChange={setStartDate}
                  onEndDateChange={setEndDate}
                  disabled={inputsLocked}
                />
              </>
            )}

            {createReview.isError ? (
              <MessageBar intent="error">
                <MessageBarBody>{createReview.error.message}</MessageBarBody>
              </MessageBar>
            ) : null}
            {createReview.savedSnapshot ? <MessageBar intent="info"><MessageBarBody>
              Snapshot #{createReview.savedSnapshot.result.sequenceNumber} is already saved. Retry uses its original agent and dates. Closing this dialog leaves it in history, where scheduling can be resumed.
              <Button disabled={createReview.isPending} onClick={() => { onOpenChange(false); onCreated(createReview.savedSnapshot!, assetType); }}>Open saved review</Button>
            </MessageBarBody></MessageBar> : null}
          </DialogContent>
          <DialogActions className={styles.actions}>
            <Button
              appearance="primary"
              disabled={!canCreate}
              icon={createReview.isPending ? <Spinner size="tiny" /> : undefined}
              onClick={handleCreate}
            >
              {createReview.savedSnapshot ? 'Retry scheduling saved snapshot' : 'Create'}
            </Button>
            <Button appearance="secondary" disabled={createReview.isPending} onClick={close}>
              Cancel
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
