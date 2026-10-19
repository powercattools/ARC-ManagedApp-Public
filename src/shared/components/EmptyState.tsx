/**
 * Centered placeholder for surfaces with nothing to show.
 *
 * This is the CoreAI `EmptyState` template, which the design system publishes as
 * copy-paste source rather than an importable component. The four documented
 * variants map onto the states this app needs (FR-118 to FR-122):
 *
 *   default        - no data yet, with a primary create action
 *   no results     - a search or filter matched nothing; intentionally no action
 *   error          - load failed, with a primary "Try again"
 *   no permissions - a secondary "Request access", so it doesn't compete with
 *                    the primary create actions elsewhere on the page
 */

import type { ComponentType, ReactNode } from 'react';
import { Body1, Subtitle1, makeStyles, tokens } from '@fluentui/react-components';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center',
    gap: tokens.spacingVerticalS,
    padding: `${tokens.spacingVerticalXXXL} ${tokens.spacingHorizontalXXL}`,
    minHeight: '320px',
  },
  icon: {
    fontSize: '48px',
    lineHeight: '48px',
    color: tokens.colorNeutralForeground4,
    marginBottom: tokens.spacingVerticalS,
  },
  illustration: {
    display: 'flex',
    marginBottom: tokens.spacingVerticalM,
  },
  description: {
    color: tokens.colorNeutralForeground2,
    maxWidth: '420px',
  },
  action: {
    marginTop: tokens.spacingVerticalM,
  },
});

export interface EmptyStateProps {
  /** Icon rendered above the title, e.g. `DatabaseRegular`. Ignored when `illustration` is set. */
  icon: ComponentType<{ className?: string }>;
  /**
   * Larger artwork shown instead of the icon. Reserved for a page's primary
   * empty state; secondary states (no results, errors, coming soon) stay on the
   * icon so they do not compete with it.
   */
  illustration?: ReactNode;
  /** Short heading, e.g. "No reviews yet". */
  title: string;
  /** One or two sentences of supporting guidance. */
  description: string;
  /** Optional call to action. Omit when there is nothing actionable. */
  action?: ReactNode;
}

export function EmptyState({
  icon: Icon,
  illustration,
  title,
  description,
  action,
}: EmptyStateProps) {
  const styles = useStyles();

  return (
    <div className={styles.root} role="status">
      {illustration ? (
        <div className={styles.illustration}>{illustration}</div>
      ) : (
        <Icon className={styles.icon} />
      )}
      <Subtitle1>{title}</Subtitle1>
      <Body1 className={styles.description}>{description}</Body1>
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
