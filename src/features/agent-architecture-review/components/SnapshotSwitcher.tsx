/**
 * The chevron beside "Results #N" (Figma `8959:21674`).
 *
 * A review is a sequence of snapshots that deliberately disagree, so the quickest thing a reader wants
 * from a result is the one before it. The chevron lists them rather than sending the reader back to the
 * review page to pick one.
 */

import {
  Button,
  Menu,
  MenuItemRadio,
  MenuList,
  MenuPopover,
  MenuTrigger,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ChevronDownRegular } from '@fluentui/react-icons';
import { useReviewResults } from '../hooks/use-reviews';
import type { ReviewResult } from '../models/review';

const useStyles = makeStyles({
  trigger: { minWidth: 'unset', paddingLeft: tokens.spacingHorizontalXXS, paddingRight: tokens.spacingHorizontalXXS },
});

export interface SnapshotSwitcherProps {
  reviewId: string;
  current: ReviewResult;
  onSelect: (resultId: string) => void;
}

export function SnapshotSwitcher({ reviewId, current, onSelect }: SnapshotSwitcherProps) {
  const styles = useStyles();
  const results = useReviewResults(reviewId);

  const snapshots = [...(results.data ?? [])].sort((a, b) => b.sequenceNumber - a.sequenceNumber);

  // One snapshot is not a choice, and an empty chevron invites a click that does nothing.
  if (snapshots.length < 2) return null;

  return (
    <Menu checkedValues={{ snapshot: [current.id] }}>
      <MenuTrigger disableButtonEnhancement>
        <Button
          appearance="subtle"
          size="small"
          className={styles.trigger}
          icon={<ChevronDownRegular />}
          aria-label="Switch snapshot"
        />
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          {snapshots.map(snapshot => (
            <MenuItemRadio
              key={snapshot.id}
              name="snapshot"
              value={snapshot.id}
              onClick={() => onSelect(snapshot.id)}
            >
              Results #{snapshot.sequenceNumber}
              {snapshot.status === 'active' ? ' · current' : ''}
              {snapshot.score === null ? '' : ` · ${snapshot.score}/100`}
            </MenuItemRadio>
          ))}
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
