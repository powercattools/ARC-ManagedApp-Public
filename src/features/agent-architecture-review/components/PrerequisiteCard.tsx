/**
 * One row of the Setup checklist (Figma frame 8647:24939).
 *
 * A card with rows to show becomes a disclosure. The "Re-check" and help
 * affordances sit outside that disclosure button rather than inside it, because
 * a button nested in a button is invalid and swallows the inner control's
 * accessible name.
 */

import { useId, useState } from 'react';
import {
  Badge,
  Body1Strong,
  Button,
  Caption1,
  Link,
  Spinner,
  Switch,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import {
  CheckmarkCircleFilled,
  ChevronDownRegular,
  ChevronRightRegular,
  ErrorCircleFilled,
  LockClosedRegular,
  QuestionCircleFilled,
  WarningFilled,
} from '@fluentui/react-icons';
import { ConnectionPicker } from './ConnectionPicker';
import type { CheckItem, CheckStatus, PrerequisiteCheck } from '../models/setup';

/** Read from the Figma file — the danger chip is not a stock Fluent Badge. */
const DANGER_BACKGROUND = '#fdf3f4';
const DANGER_BORDER = '#eeacb2';
const DANGER_FOREGROUND = '#b10e1c';

const useStyles = makeStyles({
  card: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    paddingRight: tokens.spacingHorizontalL,
  },
  disclosure: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    flexGrow: 1,
    minWidth: 0,
    textAlign: 'left',
    background: 'none',
    border: 'none',
    font: 'inherit',
    color: 'inherit',
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
    cursor: 'pointer',
    borderRadius: tokens.borderRadiusMedium,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  disclosureStatic: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    flexGrow: 1,
    minWidth: 0,
    padding: `${tokens.spacingVerticalM} ${tokens.spacingHorizontalL}`,
  },
  text: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
  detail: { color: tokens.colorNeutralForeground2 },
  icon: { fontSize: '24px', flexShrink: 0 },
  pass: { color: tokens.colorPaletteGreenBackground3 },
  fail: { color: tokens.colorPaletteRedBackground3 },
  warning: { color: tokens.colorPaletteYellowForeground2 },
  unknown: { color: tokens.colorNeutralForeground4 },
  chevron: { color: tokens.colorNeutralForeground3, flexShrink: 0 },
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexShrink: 0,
  },
  blocksChip: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    backgroundColor: DANGER_BACKGROUND,
    border: `1px solid ${DANGER_BORDER}`,
    color: DANGER_FOREGROUND,
    borderRadius: tokens.borderRadiusMedium,
    padding: `2px ${tokens.spacingHorizontalS}`,
    whiteSpace: 'nowrap',
  },
  items: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    display: 'flex',
    flexDirection: 'column',
  },
  readOnlyNote: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    color: tokens.colorNeutralForeground3,
    backgroundColor: tokens.colorNeutralBackground2,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
    borderBottom: `1px solid ${tokens.colorNeutralStroke3}`,
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalL}`,
    ':not(:last-child)': { borderBottom: `1px solid ${tokens.colorNeutralStroke3}` },
  },
  itemText: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  itemCaption: { color: tokens.colorNeutralForeground3 },
  itemActions: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexShrink: 0,
  },
});

const STATUS_ICONS: Record<CheckStatus, typeof CheckmarkCircleFilled> = {
  pass: CheckmarkCircleFilled,
  fail: ErrorCircleFilled,
  warning: WarningFilled,
  unknown: QuestionCircleFilled,
};

const BADGE_COLOR: Record<CheckStatus, 'success' | 'danger' | 'warning' | 'informative'> = {
  pass: 'success',
  fail: 'danger',
  warning: 'warning',
  unknown: 'informative',
};

export interface PrerequisiteCardProps {
  check: PrerequisiteCheck;
  onRecheck: () => void;
  /** Turns a cloud flow on or off. */
  onToggleFlow?: (item: CheckItem, on: boolean) => void;
  /** Points a connection reference at a different connection. */
  onMapConnection?: (item: CheckItem, connectionName: string) => void;
  /** Runs the guided Agents setup for a row marked `guidedSetup`. */
  onGuidedSetup?: (item: CheckItem) => void;
  /**
   * Show the card's rows but offer no controls. Used for global checks while a
   * different environment is selected: the configuration is worth seeing from
   * anywhere, but it belongs to the app's own environment and editing it from
   * elsewhere would change it for every environment without saying so.
   */
  readOnly?: boolean;
  /** Named in the read-only note, so "elsewhere" is not left vague. */
  readOnlyOwner?: string;
  busy?: boolean;
  /** Row currently being written, so only that row shows progress. */
  pendingItemId?: string;
}

export function PrerequisiteCard({
  check,
  onRecheck,
  onToggleFlow,
  onMapConnection,
  onGuidedSetup,
  readOnly,
  readOnlyOwner,
  busy,
  pendingItemId,
}: PrerequisiteCardProps) {
  const styles = useStyles();
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();

  const items = check.items ?? [];
  const expandable = items.length > 0;
  const StatusIcon = STATUS_ICONS[check.status];
  const Chevron = expanded ? ChevronDownRegular : ChevronRightRegular;

  const body = (
    <>
      {/*
        Griffel class names must be combined with `mergeClasses`. Joining them
        into a template string leaves two sequence hashes in one attribute and
        the second rule silently loses, which rendered every status icon in the
        default foreground instead of its status colour.
      */}
      <StatusIcon className={mergeClasses(styles.icon, styles[check.status])} />
      <span className={styles.text}>
        <Body1Strong truncate>{check.title}</Body1Strong>
        <Caption1 className={styles.detail}>{check.detail}</Caption1>
      </span>
      {expandable ? <Chevron className={styles.chevron} /> : null}
    </>
  );

  return (
    <div className={styles.card}>
      <div className={styles.row}>
        {expandable ? (
          <button
            type="button"
            className={styles.disclosure}
            aria-expanded={expanded}
            aria-controls={panelId}
            onClick={() => setExpanded((open) => !open)}
          >
            {body}
          </button>
        ) : (
          <div className={styles.disclosureStatic}>{body}</div>
        )}

        <div className={styles.actions}>
          {check.blocks ? (
            <Caption1 className={styles.blocksChip}>
              <WarningFilled fontSize={12} aria-hidden />
              {check.blocks}
            </Caption1>
          ) : null}
          {check.helpUrl ? (
            <Link href={check.helpUrl} target="_blank" rel="noreferrer">
              {check.helpLabel ?? 'Learn more'}
            </Link>
          ) : null}
          <Button appearance="subtle" size="small" onClick={onRecheck} disabled={busy}>
            Re-check
          </Button>
        </div>
      </div>

      {expandable && expanded ? (
        <div className={styles.items} id={panelId}>
          {readOnly ? (
            <div className={styles.readOnlyNote}>
              <LockClosedRegular fontSize={14} aria-hidden />
              <Caption1>
                {`Shared setup, owned by ${readOnlyOwner ?? 'the environment this app is installed in'}. Switch the environment picker back to it to make changes.`}
              </Caption1>
            </div>
          ) : null}
          {items.map((item) => (
            <div key={item.id} className={styles.item}>
              <span className={styles.itemText}>
                <Caption1>{item.label}</Caption1>
                {item.caption ? (
                  <Caption1 className={styles.itemCaption}>{item.caption}</Caption1>
                ) : null}
              </span>
              <span className={styles.itemActions}>
                {item.stateLabel ? (
                  <Badge shape="rounded" appearance="tint" color={BADGE_COLOR[item.status]}>
                    {item.stateLabel}
                  </Badge>
                ) : null}

                {readOnly ? null : item.guidedSetup ? (
                  pendingItemId === item.id ? (
                    <Spinner size="tiny" label="Setting up" labelPosition="after" />
                  ) : onGuidedSetup ? (
                    <Button
                      size="small"
                      appearance={item.status === 'pass' ? 'secondary' : 'primary'}
                      icon={item.status === 'pass' ? <CheckmarkCircleFilled /> : undefined}
                      disabled={busy}
                      onClick={() => onGuidedSetup(item)}
                    >
                      {item.status === 'pass' ? 'Re-run setup' : 'Set up agent review'}
                    </Button>
                  ) : null
                ) : item.connection && onMapConnection ? (
                  <ConnectionPicker
                    connectorId={item.connection.connectorId}
                    connectionId={item.connection.connectionId}
                    busy={pendingItemId === item.id}
                    disabled={busy}
                    ariaLabel={`Connection for ${item.label}`}
                    onSelect={(connectionName) => onMapConnection(item, connectionName)}
                  />
                ) : null}

                {!readOnly &&
                onToggleFlow &&
                (item.canEnable || item.canDisable || item.flowOn !== undefined) ? (
                  pendingItemId === item.id ? (
                    <Spinner size="tiny" label="Saving" labelPosition="after" />
                  ) : (
                    <Switch
                      checked={Boolean(item.flowOn)}
                      aria-label={`${item.label} enabled`}
                      // Turning on is refused until every connection is mapped;
                      // turning off is always permitted.
                      disabled={busy || (item.flowOn ? !item.canDisable : !item.canEnable)}
                      onChange={(_, data) => onToggleFlow(item, data.checked)}
                    />
                  )
                ) : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
