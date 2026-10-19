/**
 * First-run banner on the Setup screen (Figma frame 8647:24939).
 *
 * Dismissal is remembered per browser so the banner does not reappear on every
 * visit, but it is never load-bearing: if storage is unavailable the banner
 * simply shows again, which is harmless.
 */

import { useCallback, useState } from 'react';
import { Body1Strong, Button, Caption1, Link, makeStyles, tokens } from '@fluentui/react-components';
import { DismissRegular, SparkleFilled } from '@fluentui/react-icons';

const STORAGE_KEY = 'aar.setup.welcome-dismissed';

/** Figma brand ramp — CoreAI purple, not Fluent's default blue brand. */
const WELCOME_BACKGROUND = '#e1cefc';
const WELCOME_BORDER = '#8251ee';

const useStyles = makeStyles({
  banner: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalM,
    backgroundColor: WELCOME_BACKGROUND,
    border: `1px solid ${WELCOME_BORDER}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
  },
  sparkle: { color: WELCOME_BORDER, fontSize: '16px', flexShrink: 0, marginTop: '2px' },
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, flexGrow: 1 },
  copy: { color: tokens.colorNeutralForeground1 },
  actions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
});

function readDismissed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export interface SetupWelcomeBannerProps {
  onRerunAll: () => void;
  onCopyAdminLink: () => void;
  copyLabel: string;
  busy?: boolean;
}

export function SetupWelcomeBanner({
  onRerunAll,
  onCopyAdminLink,
  copyLabel,
  busy,
}: SetupWelcomeBannerProps) {
  const styles = useStyles();
  const [dismissed, setDismissed] = useState(readDismissed);

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem(STORAGE_KEY, 'true');
    } catch {
      // Remembering the dismissal is a convenience, not a requirement.
    }
  }, []);

  if (dismissed) return null;

  return (
    <div className={styles.banner}>
      <SparkleFilled className={styles.sparkle} aria-hidden />
      <div className={styles.body}>
        <Caption1 className={styles.copy}>
          <Body1Strong>Welcome! Let&apos;s set you up. </Body1Strong>
          This is the first launch of Agent Review Center in this environment. Below is the
          readiness checklist. Anything red or yellow will limit what the tool can do for you; you
          can still run static analysis while these are being fixed.{' '}
          <Link
            href="https://learn.microsoft.com/microsoft-copilot-studio/analytics-sessions"
            target="_blank"
            rel="noreferrer"
          >
            Learn more
          </Link>
        </Caption1>
        <div className={styles.actions}>
          <Button appearance="subtle" size="small" onClick={onRerunAll} disabled={busy}>
            Re-run all checks
          </Button>
          <Button appearance="subtle" size="small" onClick={onCopyAdminLink}>
            {copyLabel}
          </Button>
        </div>
      </div>
      <Button
        appearance="transparent"
        icon={<DismissRegular />}
        aria-label="Dismiss welcome message"
        onClick={dismiss}
      />
    </div>
  );
}
