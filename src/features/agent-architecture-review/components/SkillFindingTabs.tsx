/**
 * The skills a finding touches, one tab each, appended to that finding's drawer.
 *
 * A finding names its affected components, but a component name only ever opened a second drawer on
 * top of the first — so reading "which skill, and how good is it" meant losing the finding. The
 * tabs put the skill's rubric under the argument that referred to it, and the names in the affected
 * list are now plain text because this is the better route to the same thing.
 *
 * A `SkillView` carries scores and files but no findings, so each tab's findings are derived here
 * from the consolidated review by matching the affected component's id or name.
 */

import { Divider, Tab, TabList, makeStyles, tokens } from '@fluentui/react-components';
import { useMemo, useState } from 'react';

import { allRows, type ConsolidatedRow, type ConsolidatedView, type FindingsTableRow } from '@review-ui';
import type { SkillView } from '../engine/scoring/art-ports';
import { SkillRubricPanel } from './SkillRubricPanel';

const useStyles = makeStyles({
  root: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },
  tabs: { overflowX: 'auto' },
});

/**
 * A component reference resolved to the skill it names.
 *
 * Matched on id, then schema name, then display name, so a reference written any of the three ways
 * reaches the same rubric.
 */
function skillFor(
  affected: { id?: string | undefined; name: string },
  skills: readonly SkillView[],
): SkillView | undefined {
  const id = affected.id;
  return (id ? skills.find(s => s.id === id) : undefined)
    ?? (id ? skills.find(s => s.schemaName === id) : undefined)
    ?? skills.find(s => s.name === affected.name);
}

/** Every skill a row refers to, in the row's own order, without repeats. */
function skillsForRow(row: ConsolidatedRow, skills: readonly SkillView[]): readonly SkillView[] {
  const picked: SkillView[] = [];
  for (const a of row.affected) {
    const match = skillFor(a, skills);
    if (match && !picked.some(s => s.id === match.id)) picked.push(match);
  }
  return picked;
}

/** This skill's verdicts, read off the consolidated review rather than off the skill. */
function findingsForSkill(view: ConsolidatedView, skill: SkillView): readonly FindingsTableRow[] {
  return allRows(view)
    .filter(r => r.affected.some(a => skillFor(a, [skill])?.id === skill.id))
    .map(r => ({
      key: r.key,
      title: r.title,
      // A dismissed finding still happened; it just no longer counts, which is what `ignored` says.
      tone: r.dismissed === true ? ('ignored' as const) : r.tone,
      ...(r.fact ? { fact: r.fact } : {}),
      ...(r.acceptanceCheck ? { acceptanceCheck: r.acceptanceCheck } : {}),
    }));
}

export interface SkillFindingTabsProps {
  row: ConsolidatedRow;
  skills: readonly SkillView[];
  view: ConsolidatedView;
}

export function SkillFindingTabs({ row, skills, view }: SkillFindingTabsProps) {
  const styles = useStyles();
  const matched = useMemo(() => skillsForRow(row, skills), [row, skills]);
  const [pickedId, setPickedId] = useState<string | undefined>(undefined);

  const selected = matched.find(s => s.id === pickedId) ?? matched[0];
  const findings = useMemo(
    () => (selected ? findingsForSkill(view, selected) : []),
    [view, selected],
  );

  if (!selected) return null;

  return (
    <div className={styles.root}>
      <Divider>Skills</Divider>

      {matched.length > 1 ? (
        <TabList
          className={styles.tabs}
          selectedValue={selected.id}
          onTabSelect={(_, d) => setPickedId(d.value as string)}
        >
          {matched.map(s => <Tab key={s.id} value={s.id}>{s.name}</Tab>)}
        </TabList>
      ) : null}

      <SkillRubricPanel key={selected.id} skill={selected} findings={findings} header />
    </div>
  );
}
