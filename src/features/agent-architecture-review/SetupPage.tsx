/**
 * Setup — the readiness checklist behind the banner gear (Figma frame 8647:24939).
 *
 * Every check answers for one environment. It defaults to the environment the
 * app runs in, but transcript recording is an environment-level setting and the
 * agent being reviewed often lives somewhere else, so the environment being
 * checked is selectable.
 */

import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Link,
  MessageBar,
  MessageBarBody,
  Option,
  Skeleton,
  SkeletonItem,
  Subtitle2,
  Title3,
  Toast,
  ToastTitle,
  Toaster,
  makeStyles,
  tokens,
  useId,
  useToastController,
} from '@fluentui/react-components';
import { ArrowClockwiseRegular, ArrowLeftRegular } from '@fluentui/react-icons';
import { PrerequisiteCard } from './components/PrerequisiteCard';
import { SetupWelcomeBanner } from './components/SetupWelcomeBanner';
import { useMapConnection, useSetFlowState, useSetupAgentReview, useSetupChecks } from './hooks/use-setup';
import { useEnvironments } from './hooks/use-reviews';
import { CURRENT_ORGANIZATION, normalizeConnectionId } from './services/setup-service';
import type { CheckItem } from './models/setup';

const useStyles = makeStyles({
  page: {
    padding: `${tokens.spacingVerticalXXL} ${tokens.spacingHorizontalXXL}`,
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalL,
    width: '100%',
    maxWidth: '1024px',
    marginLeft: 'auto',
    marginRight: 'auto',
  },
  back: { alignSelf: 'flex-start', paddingLeft: 0 },
  confirmBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
  },
  headerRow: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalL,
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingBottom: tokens.spacingVerticalL,
  },
  heading: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  subtitle: { color: tokens.colorNeutralForeground2 },
  headerActions: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexShrink: 0,
  },
  environmentPicker: { minWidth: '260px' },
  pickerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
  sectionLabel: { color: tokens.colorNeutralForeground1 },
  list: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS },
  skeletonCard: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: tokens.spacingHorizontalL,
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
  },
  skeletonText: { display: 'flex', flexDirection: 'column', gap: '6px', flexGrow: 1 },
});

function LoadingChecks() {
  const styles = useStyles();
  return (
    <Skeleton aria-label="Running checks">
      <div className={styles.list}>
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className={styles.skeletonCard}>
            <SkeletonItem shape="circle" size={24} />
            <div className={styles.skeletonText}>
              <SkeletonItem size={16} style={{ width: '40%' }} />
              <SkeletonItem size={12} style={{ width: '65%' }} />
            </div>
          </div>
        ))}
      </div>
    </Skeleton>
  );
}

export default function SetupPage() {
  const styles = useStyles();
  const navigate = useNavigate();
  const toasterId = useId('setup-toaster');
  const { dispatchToast } = useToastController(toasterId);

  const [organization, setOrganization] = useState<string>(CURRENT_ORGANIZATION);
  const [pendingItemId, setPendingItemId] = useState<string | undefined>();
  const [pendingChange, setPendingChange] = useState<
    { item: CheckItem; connectionName: string } | undefined
  >();

  const checks = useSetupChecks(organization);
  const environments = useEnvironments();
  const setFlowState = useSetFlowState();
  const mapConnection = useMapConnection();
  const setupAgentReview = useSetupAgentReview();

  const summary = checks.data;
  const isBusy = checks.isFetching;

  const homeName = summary?.homeEnvironmentName;

  /**
   * Label for the sentinel option. The environments query returns the app's own
   * environment alongside the others, so naming the sentinel "Current
   * environment" and leaving the named duplicate in the list offered the same
   * environment twice under two labels. The duplicate is filtered out below.
   */
  const currentOptionLabel = homeName ? `${homeName} (current)` : 'Current environment';

  const environmentName = useMemo(() => {
    if (organization === CURRENT_ORGANIZATION) return currentOptionLabel;
    return (
      environments.data?.find((environment) => environment.url === organization)?.friendlyName ??
      organization
    );
  }, [currentOptionLabel, environments.data, organization]);

  const notify = useCallback(
    (message: string, intent: 'success' | 'error') => {
      dispatchToast(
        <Toast>
          <ToastTitle>{message}</ToastTitle>
        </Toast>,
        { intent },
      );
    },
    [dispatchToast],
  );

  const handleToggleFlow = useCallback(
    (item: CheckItem, on: boolean) => {
      setPendingItemId(item.id);
      setFlowState.mutate(
        { workflowId: item.id, on },
        {
          onSuccess: () => notify(`${item.label} is now ${on ? 'on' : 'off'}.`, 'success'),
          onError: (error: unknown) =>
            notify(
              error instanceof Error ? error.message : 'Could not change the flow state.',
              'error',
            ),
          onSettled: () => setPendingItemId(undefined),
        },
      );
    },
    [notify, setFlowState],
  );

  const handleGuidedSetup = useCallback(
    (item: CheckItem) => {
      setPendingItemId(item.id);
      setupAgentReview.mutate(undefined, {
        onSuccess: () =>
          notify('Agent review is set up. The connection is bound and the flow is on.', 'success'),
        onError: (error: unknown) =>
          notify(
            error instanceof Error ? error.message : 'Could not set up agent review.',
            'error',
          ),
        onSettled: () => setPendingItemId(undefined),
      });
    },
    [notify, setupAgentReview],
  );

  const commitMapConnection = useCallback(
    (item: CheckItem, connectionName: string) => {
      const referenceId = item.connection?.referenceId;
      if (!referenceId) return;
      setPendingItemId(item.id);
      mapConnection.mutate(
        { referenceId, connectionName },
        {
          onSuccess: () => notify(`${item.label} is now connected.`, 'success'),
          onError: (error: unknown) =>
            notify(
              error instanceof Error ? error.message : 'Could not save the connection.',
              'error',
            ),
          onSettled: () => setPendingItemId(undefined),
        },
      );
    },
    [mapConnection, notify],
  );

  /**
   * Repointing a reference that is already in use is not reliably reversible:
   * Dataverse refuses to save a connection the signed-in user has no permission
   * on, so if the reference currently points at somebody else's connection they
   * cannot put it back. Confirm first, and show the outgoing id so it can be
   * written down.
   */
  const handleMapConnection = useCallback(
    (item: CheckItem, connectionName: string) => {
      const current = item.connection?.connectionId ?? null;
      const next = normalizeConnectionId(connectionName);
      if (!current || current === next) {
        commitMapConnection(item, connectionName);
        return;
      }
      setPendingChange({ item, connectionName });
    },
    [commitMapConnection],
  );

  const handleCopyAdminLink = useCallback(() => {
    if (!summary) return;
    const failing = summary.checks
      .filter((check) => check.status === 'fail' || check.status === 'warning')
      .map((check) => `- ${check.title}: ${check.detail}`);

    const text = [
      `Agent Review Center: setup help needed for ${environmentName}.`,
      '',
      failing.length > 0 ? 'Outstanding items:' : 'All checks are currently passing.',
      ...failing,
      '',
      `Admin center: ${summary.adminUrl}`,
    ].join('\n');

    void navigator.clipboard
      .writeText(text)
      .then(() => notify('Admin link and summary copied.', 'success'))
      .catch(() => notify('Could not copy to the clipboard.', 'error'));
  }, [environmentName, notify, summary]);

  const rerun = useCallback(() => void checks.refetch(), [checks]);

  return (
    <main className={styles.page}>
      <Toaster toasterId={toasterId} />

      <Button
        appearance="subtle"
        className={styles.back}
        icon={<ArrowLeftRegular />}
        onClick={() => navigate('/reviews')}
      >
        Back to reviews
      </Button>

      <div className={styles.headerRow}>
        <div className={styles.heading}>
          <Title3>Setup</Title3>
          <Caption1 className={styles.subtitle}>
            {summary
              ? `${summary.readyCount} of ${summary.totalCount} ready${
                  summary.blockingCount > 0
                    ? ` • ${summary.blockingCount} blocking issue${summary.blockingCount === 1 ? '' : 's'}`
                    : ''
                }`
              : 'Checking this environment…'}{' '}
            <Link
              href="https://learn.microsoft.com/microsoft-copilot-studio/analytics-sessions"
              target="_blank"
              rel="noreferrer"
            >
              Learn more
            </Link>
          </Caption1>
        </div>
        <div className={styles.headerActions}>
          <Button
            appearance="primary"
            icon={<ArrowClockwiseRegular />}
            onClick={rerun}
            disabled={isBusy}
          >
            Run checks
          </Button>
        </div>
      </div>

      <SetupWelcomeBanner
        onRerunAll={rerun}
        onCopyAdminLink={handleCopyAdminLink}
        copyLabel="Copy admin link"
        busy={isBusy}
      />

      <div className={styles.pickerRow}>
        <Caption1 id="setup-environment-label">Environment</Caption1>
        <Dropdown
          className={styles.environmentPicker}
          aria-labelledby="setup-environment-label"
          value={environmentName}
          selectedOptions={[organization]}
          disabled={environments.isLoading}
          onOptionSelect={(_, data) => setOrganization(data.optionValue ?? CURRENT_ORGANIZATION)}
        >
          <Option value={CURRENT_ORGANIZATION} text={currentOptionLabel}>
            {currentOptionLabel}
          </Option>
          {(environments.data ?? [])
            .filter((environment) => environment.friendlyName !== homeName)
            .map((environment) => (
              <Option key={environment.url} value={environment.url} text={environment.friendlyName}>
                {environment.friendlyName}
              </Option>
            ))}
        </Dropdown>
      </div>

      <Subtitle2 className={styles.sectionLabel}>Prerequisites</Subtitle2>

      {checks.isLoading ? <LoadingChecks /> : null}

      {checks.isError ? (
        <MessageBar intent="error">
          <MessageBarBody>
            {checks.error instanceof Error
              ? checks.error.message
              : 'Could not run the readiness checks.'}
          </MessageBarBody>
        </MessageBar>
      ) : null}

      {summary ? (
        <div className={styles.list}>
          {summary.checks.map((check) => (
            <PrerequisiteCard
              key={check.id}
              check={check}
              onRecheck={rerun}
              onToggleFlow={handleToggleFlow}
              onMapConnection={handleMapConnection}
              onGuidedSetup={handleGuidedSetup}
              readOnly={check.scope === 'global' && !summary.isHomeEnvironment}
              readOnlyOwner={summary.homeEnvironmentName}
              busy={isBusy}
              pendingItemId={pendingItemId}
            />
          ))}
        </div>
      ) : null}

      <Dialog
        open={Boolean(pendingChange)}
        onOpenChange={(_, data) => {
          if (!data.open) setPendingChange(undefined);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Change this connection?</DialogTitle>
            <DialogContent className={styles.confirmBody}>
              <span>
                {`"${pendingChange?.item.label}" already uses connection …${pendingChange?.item.connection?.connectionId?.slice(-6)}. Flows that rely on it will start running under the connection you pick instead.`}
              </span>
              <Caption1>
                {`If the current connection is not one of yours, you will not be able to set it back from here. Dataverse only accepts connections you have permission to use. Full current id: ${pendingChange?.item.connection?.connectionId ?? 'unknown'}`}
              </Caption1>
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" onClick={() => setPendingChange(undefined)}>
                Cancel
              </Button>
              <Button
                appearance="primary"
                onClick={() => {
                  if (pendingChange) {
                    commitMapConnection(pendingChange.item, pendingChange.connectionName);
                  }
                  setPendingChange(undefined);
                }}
              >
                Change connection
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </main>
  );
}
