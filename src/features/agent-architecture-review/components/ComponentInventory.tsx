/**
 * Component inventory — the "map details" view from the Agent Review Tool.
 *
 * Everything here comes from ART's own inventory of the agent, so the two tools
 * cannot disagree about what an agent is made of. Findings that name a specific
 * component are counted against it, which is what makes this a map rather than
 * a list.
 */

import { useMemo } from 'react';
import {
  Badge,
  Body1,
  Caption1,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  COMPONENT_KIND_LABELS,
  type ArtComponent,
  type ArtFinding,
  type ComponentKind,
  findingsForComponent,
} from '../models/art';

/**
 * Display order — highest-signal component types first.
 *
 * `topic` sits below knowledge deliberately. A classic agent carries a dozen or more topics, most of
 * them system boilerplate (Greeting, Fallback, On Error), so ordering them above its handful of tools
 * would bury the interesting half of the inventory under the predictable half.
 */
const KIND_ORDER: ComponentKind[] = [
  'connected-agent',
  'tool',
  'skill',
  'knowledge',
  'topic',
  'trigger',
  'test-case',
];

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  group: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  groupHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
  },
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: tokens.spacingHorizontalM,
    padding: `${tokens.spacingVerticalS} ${tokens.spacingHorizontalM}`,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  main: { display: 'flex', flexDirection: 'column', minWidth: 0 },
  empty: {
    padding: tokens.spacingVerticalXXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
  },
});

export interface ComponentInventoryProps {
  components: readonly ArtComponent[];
  findings: readonly ArtFinding[];
}

export function ComponentInventory({ components, findings }: ComponentInventoryProps) {
  const styles = useStyles();

  const grouped = useMemo(() => {
    return KIND_ORDER.map((kind) => ({
      kind,
      label: COMPONENT_KIND_LABELS[kind],
      items: components.filter((component) => component.kind === kind),
    })).filter((group) => group.items.length > 0);
  }, [components]);

  if (components.length === 0) {
    return (
      <div className={styles.empty}>
        <Body1>This review did not record a component inventory.</Body1>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {grouped.map((group) => (
        <div key={group.kind} className={styles.group}>
          <div className={styles.groupHeader}>
            <Text weight="semibold">{group.label}</Text>
            <Caption1>{group.items.length}</Caption1>
          </div>

          {group.items.map((component, index) => {
            const related = findingsForComponent(findings, component.componentIdUnique);
            const high = related.filter((finding) => finding.severity === 'error').length;
            const medium = related.filter((finding) => finding.severity === 'warning').length;

            return (
              <div key={`${component.componentIdUnique ?? component.name}-${index}`} className={styles.row}>
                <div className={styles.main}>
                  <Body1>{component.name}</Body1>
                  {component.subKind ? <Caption1>{component.subKind}</Caption1> : null}
                </div>
                <div>
                  {high > 0 ? (
                    <Badge shape="rounded" appearance="tint" color="danger">
                      {high} High
                    </Badge>
                  ) : null}{' '}
                  {medium > 0 ? (
                    <Badge shape="rounded" appearance="tint" color="warning">
                      {medium} Medium
                    </Badge>
                  ) : null}
                  {related.length === 0 ? <Caption1>No findings</Caption1> : null}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
