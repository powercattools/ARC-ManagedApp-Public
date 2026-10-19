/**
 * Connection picker for one connection reference.
 *
 * Candidates are fetched only when the dropdown is first opened, so expanding
 * the Connections card costs nothing until the user actually wants to change
 * something.
 *
 * Follows `Agent-Library`'s ConnectionService/ConnectionSetup pattern: list
 * only `Connected` connections, and always offer a way out to create a new one.
 */

import { useState } from 'react';
import {
  Caption1,
  Dropdown,
  Option,
  Spinner,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { AddRegular } from '@fluentui/react-icons';
import { useAvailableConnections, useCreateConnectionUrl } from '../hooks/use-setup';
import type { AvailableConnection } from '../services/setup-service';

const useStyles = makeStyles({
  picker: { minWidth: '300px' },
  error: { color: tokens.colorPaletteRedForeground1, maxWidth: '300px' },
  optionText: { display: 'flex', flexDirection: 'column' },
  optionCaption: { color: tokens.colorNeutralForeground3 },
  create: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS },
});

/**
 * A tenant accumulates many Dataverse connections that all carry the signed-in
 * user's UPN as their display name — 16 of them, 15 identical, in the dev
 * environment this was built against. The trailing id characters are the only
 * guaranteed-unique thing a person can match against what the admin centre
 * shows, so every label carries them.
 */
function shortId(connection: AvailableConnection): string {
  const id = connection.normalizedId ?? connection.name;
  return id.length > 6 ? `…${id.slice(-6)}` : id;
}

/** Single-line form, used for the collapsed dropdown and the a11y name. */
function describe(connection: AvailableConnection): string {
  const parts = [`${connection.displayName} · ${shortId(connection)}`];
  if (connection.role) parts.push(connection.role);
  return parts.join(' · ');
}

export interface ConnectionPickerProps {
  connectorId: string;
  /** Currently mapped connection, normalised to 32-char compact hex. */
  connectionId: string | null;
  disabled?: boolean;
  busy?: boolean;
  onSelect: (connectionName: string) => void;
  ariaLabel: string;
}

export function ConnectionPicker({
  connectorId,
  connectionId,
  disabled,
  busy,
  onSelect,
  ariaLabel,
}: ConnectionPickerProps) {
  const styles = useStyles();
  const [opened, setOpened] = useState(false);
  const connections = useAvailableConnections(opened ? connectorId : undefined);
  const createUrl = useCreateConnectionUrl(opened ? connectorId : undefined);

  const options = connections.data ?? [];
  const selected = options.find((option) => option.normalizedId === connectionId);

  // The list covers connections the signed-in user owns or has had shared with
  // them. A reference installed with a solution usually points at the
  // installer's connection, so "mapped but absent from the list" is the normal
  // case in a shared environment — not a failure. Say so, because showing no
  // selection reads like a bug.
  const foreign = Boolean(connectionId) && connections.isSuccess && !selected;

  // Until the list loads there is no display name for the mapped connection,
  // but the id tail is already known — show that rather than the bare word
  // "Connected", which reads like a status and identifies nothing.
  const value = selected
    ? describe(selected)
    : connectionId
      ? `Mapped · …${connectionId.slice(-6)}${foreign ? ' · not yours' : ''}`
      : 'Not connected';

  if (connections.isError) {
    return (
      <Caption1 className={styles.error}>
        {connections.error instanceof Error
          ? connections.error.message
          : 'Could not list connections.'}
      </Caption1>
    );
  }

  return (
    <Dropdown
      className={styles.picker}
      size="small"
      aria-label={ariaLabel}
      value={busy ? 'Saving…' : value}
      selectedOptions={selected ? [selected.name] : []}
      disabled={disabled || busy}
      onOpenChange={(_, data) => {
        if (data.open) setOpened(true);
      }}
      onOptionSelect={(_, data) => {
        if (data.optionValue === '__create') {
          if (createUrl.data) window.open(createUrl.data, '_blank', 'noopener');
          return;
        }
        // The option value is the raw connection name; the service normalises
        // it to the compact hex Dataverse persists.
        if (data.optionValue && !data.optionValue.startsWith('__')) onSelect(data.optionValue);
      }}
      listbox={{ className: styles.picker }}
    >
      {connections.isLoading ? (
        <Option value="__loading" text="Loading connections…" disabled>
          <Spinner size="tiny" label="Loading connections…" labelPosition="after" />
        </Option>
      ) : null}

      {foreign ? (
        <Option value="__foreign" text="Current connection is not one of yours" disabled>
          <span className={styles.optionText}>
            <span>{`In use: …${connectionId?.slice(-6)}`}</span>
            <Caption1 className={styles.optionCaption}>
              Owned by someone else. Choosing below repoints this reference
            </Caption1>
          </span>
        </Option>
      ) : null}

      {!connections.isLoading && options.length === 0 ? (
        <Option value="__empty" text="No connections found" disabled>
          No connected connections for this connector
        </Option>
      ) : null}

      {options.map((connection) => {
        return (
          <Option key={connection.name} value={connection.name} text={describe(connection)}>
            <span className={styles.optionText}>
              <span>
                {connection.displayName}
                {connection.normalizedId === connectionId ? ' (current)' : ''}
              </span>
              <Caption1 className={styles.optionCaption}>
                {[shortId(connection), connection.role].filter(Boolean).join(' · ')}
              </Caption1>
            </span>
          </Option>
        );
      })}

      {!connections.isLoading && createUrl.data ? (
        <Option value="__create" text="Create a new connection">
          <span className={styles.create}>
            <AddRegular />
            Create a new connection
          </span>
        </Option>
      ) : null}
    </Dropdown>
  );
}
