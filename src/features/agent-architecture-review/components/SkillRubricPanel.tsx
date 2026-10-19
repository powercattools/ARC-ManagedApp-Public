/**
 * One skill's body — its facts, its findings and its rubric — with no chrome of its own.
 *
 * It exists because the same body is now read in two places: the drawer opened from a component
 * chip, and the per-skill tabs appended to a finding's drawer. Rendering it twice would let the two
 * drift, and the numbers are ART's, so a second copy could start disagreeing about a score without
 * either copy being obviously wrong.
 *
 * The numbers are ART's — percent, band, weakest dimension and the four qualified bundle scores all
 * come from `art-ports`, never from arithmetic done here. The screen is this app's.
 */

import {
  Badge,
  Body1,
  Body1Strong,
  Caption1,
  Caption1Strong,
  Tab,
  TabList,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  DocumentRegular,
  ShieldCheckmarkRegular,
  ShieldErrorRegular,
} from '@fluentui/react-icons';
import { useMemo, useState } from 'react';

import { CollapsibleSection, FindingsTable, type FindingsTableRow } from '@review-ui';
import {
  buildSkillFileExplorerModel,
  definitionUnavailableText,
  dimensionBand,
  normalizedDimensionScore,
  resolveSelectedSkillFile,
  scoreBand,
  skillScorePercent,
  weakestDimension,
  type QualifiedScoreView,
  type SkillFileExplorerEntry,
  type SkillView,
} from '../engine/scoring/art-ports';

const BAR_COLOR = {
  success: tokens.colorPaletteGreenForeground1,
  warning: tokens.colorPaletteYellowForeground1,
  danger: tokens.colorPaletteRedForeground1,
} as const;

const useStyles = makeStyles({
  panel: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, minWidth: 0 },

  titleLine: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minWidth: 0 },
  titleName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  grade: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, flexShrink: 0 },

  /*
   * Facts about the bundle rather than judgements of it, so they read as one quiet line — and as
   * ONE line: wrapping turned four short facts into a three-row block that looked like a list of
   * problems. Anything that does not fit scrolls rather than stacking.
   */
  factLine: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'nowrap',
    overflowX: 'auto',
    gap: tokens.spacingHorizontalS,
    color: tokens.colorNeutralForeground3,
    '> *': { flexShrink: 0 },
  },
  fact: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXXS },
  factDivider: { color: tokens.colorNeutralStroke1 },
  safe: { color: tokens.colorPaletteGreenForeground1 },
  unsafe: { color: tokens.colorPaletteRedForeground1 },

  block: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  label: { color: tokens.colorNeutralForeground3 },

  rows: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  row: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXXS },
  rowHead: { display: 'flex', alignItems: 'baseline', gap: tokens.spacingHorizontalS },
  rowValue: { marginLeft: 'auto' },
  track: {
    height: '4px',
    width: '100%',
    borderRadius: tokens.borderRadiusCircular,
    backgroundColor: tokens.colorNeutralBackground5,
    overflow: 'hidden',
  },
  rationale: { color: tokens.colorNeutralForeground2 },

  // A list narrow enough to leave the source readable, beside a pane that scrolls on its own.
  explorer: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: tokens.spacingHorizontalM,
  },
  fileList: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalXXS,
    width: '170px',
    flexShrink: 0,
    maxHeight: '58vh',
    overflowY: 'auto',
  },
  fileCount: { color: tokens.colorNeutralForeground3, padding: `0 0 ${tokens.spacingVerticalXS}` },
  fileRow: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalXS,
    padding: `${tokens.spacingVerticalXS} ${tokens.spacingHorizontalS}`,
    borderRadius: tokens.borderRadiusMedium,
    border: 'none',
    borderLeft: `2px solid transparent`,
    backgroundColor: 'transparent',
    cursor: 'pointer',
    textAlign: 'left',
    color: tokens.colorNeutralForeground1,
    ':hover': { backgroundColor: tokens.colorNeutralBackground1Hover },
  },
  fileRowOn: {
    backgroundColor: tokens.colorNeutralBackground1Selected,
    borderLeftColor: tokens.colorBrandStroke1,
  },
  fileName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  fileIcon: { color: tokens.colorNeutralForeground3, flexShrink: 0 },

  pane: {
    display: 'flex',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    flexGrow: 1,
    minWidth: 0,
  },
  paneHead: {
    display: 'flex',
    alignItems: 'center',
    gap: tokens.spacingHorizontalS,
    flexWrap: 'wrap',
  },
  paneName: { overflowWrap: 'anywhere' },
  paneSize: { marginLeft: 'auto', color: tokens.colorNeutralForeground3, flexShrink: 0 },
  // The point of the tab: the text as written, wrapped rather than clipped.
  source: {
    margin: 0,
    padding: tokens.spacingVerticalM,
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground3,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    fontFamily: tokens.fontFamilyMonospace,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase300,
    color: tokens.colorNeutralForeground1,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'anywhere',
    maxHeight: '52vh',
    overflowY: 'auto',
  },
});

/** A 0-100 bar. `null` draws an empty track, because "no score" is not "zero". */
function ScoreBar({ percent, tone }: { percent: number | null; tone: 'success' | 'warning' | 'danger' }) {
  const styles = useStyles();
  return (
    <div className={styles.track}>
      {percent === null ? null : (
        <div style={{ width: `${percent}%`, height: '100%', backgroundColor: BAR_COLOR[tone] }} />
      )}
    </div>
  );
}

/** One of ART's four qualified bundle scores. Its status is shown whenever it is not complete. */
function QualifiedRow({ label, score }: { label: string; score: QualifiedScoreView | undefined }) {
  const styles = useStyles();
  // An unavailable score is not a zero; showing the raw 0 would read as the worst possible result.
  const value = !score || score.status === 'unavailable' ? null : score.value;
  const tone = value === null ? 'danger' : value >= 80 ? 'success' : value >= 60 ? 'warning' : 'danger';

  return (
    <div className={styles.row}>
      <div className={styles.rowHead}>
        <Caption1>{label}</Caption1>
        <Body1Strong className={styles.rowValue}>{value === null ? 'N/A' : value}</Body1Strong>
      </div>
      <ScoreBar percent={value} tone={tone} />
      {score && score.status !== 'complete' ? (
        <Caption1 className={styles.label}>
          {score.status}{score.note ? ` · ${score.note}` : ''}
        </Caption1>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** `scope_discipline` reads as a label, not an identifier. */
export function dimensionLabel(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The skill's name, its kind and its grade, on one line.
 *
 * Shared so the chip-opened drawer's header and the per-skill tab panel cannot describe the same
 * skill differently.
 */
export function SkillTitleLine({ skill }: { skill: SkillView | undefined }) {
  const styles = useStyles();
  const percent = skill ? skillScorePercent(skill) : null;
  const band = percent === null ? null : scoreBand(percent);

  return (
    <div className={styles.titleLine}>
      <Body1Strong className={styles.titleName}>{skill?.name ?? 'Skill'}</Body1Strong>
      <Badge shape="rounded" appearance="outline" color="informative" size="small">Skill</Badge>
      {percent === null ? null : (
        <span className={styles.grade}>
          <Body1Strong>{percent}%</Body1Strong>
          <Badge shape="rounded" appearance="outline" color={band?.color} size="small">{band?.label}</Badge>
        </span>
      )}
    </div>
  );
}

/**
 * The bundle's files, and the source of the one file whose text a saved review retains.
 *
 * Only SKILL.md is kept verbatim — ART stores a sanitized analysis of every other resource rather
 * than its content — so the pane shows the definition's text and says plainly why any other file
 * has none, instead of implying the bundle was empty.
 */
function SkillFiles({ skill }: { skill: SkillView }) {
  const styles = useStyles();
  const model = useMemo(() => buildSkillFileExplorerModel(skill), [skill]);
  const [pickedId, setPickedId] = useState<string | undefined>(undefined);
  const selected = resolveSelectedSkillFile(model.entries, pickedId);

  if (model.availability !== 'available' || !selected) {
    return (
      <Caption1 className={styles.label}>
        {model.availability === 'historical'
          ? 'This review was saved before its file inventory was retained.'
          : 'No file inventory was stored for this skill.'}
      </Caption1>
    );
  }

  return (
    <div className={styles.explorer}>
      <div className={styles.fileList} role="listbox" aria-label="Files in this skill">
        <Caption1 className={styles.fileCount}>
          {model.entries.length} {model.entries.length === 1 ? 'file' : 'files'}
        </Caption1>
        {model.entries.map((entry: SkillFileExplorerEntry) => {
          const on = entry.entryId === selected.entryId;
          return (
            <button
              key={entry.entryId}
              type="button"
              role="option"
              aria-selected={on}
              title={entry.displayPath}
              className={on ? `${styles.fileRow} ${styles.fileRowOn}` : styles.fileRow}
              onClick={() => setPickedId(entry.entryId)}
            >
              <DocumentRegular className={styles.fileIcon} />
              <Caption1 className={styles.fileName}>{entry.name}</Caption1>
            </button>
          );
        })}
      </div>

      <div className={styles.pane}>
        <div className={styles.paneHead}>
          <Body1Strong className={styles.paneName}>{selected.name}</Body1Strong>
          {selected.language ? (
            <Badge shape="rounded" appearance="outline" color="brand" size="small">
              {dimensionLabel(selected.language)}
            </Badge>
          ) : null}
          <Caption1 className={styles.paneSize}>{formatBytes(selected.sizeBytes)}</Caption1>
        </div>

        {selected.isSkillDefinition ? (
          selected.sourceText ? (
            <pre className={styles.source}>{selected.sourceText.trimEnd()}</pre>
          ) : (
            <Caption1 className={styles.label}>{definitionUnavailableText(selected)}</Caption1>
          )
        ) : (
          <Caption1 className={styles.label}>
            Only SKILL.md is kept verbatim. This review stored a sanitized analysis of this
            resource rather than its content.
          </Caption1>
        )}
      </div>
    </div>
  );
}

export interface SkillRubricPanelProps {
  skill: SkillView | undefined;
  /**
   * This skill's findings.
   *
   * Supplied by the surface rather than read off the skill, because a `SkillView` carries scores
   * and files but no findings — the verdicts live in the consolidated review, keyed by component.
   */
  findings?: readonly FindingsTableRow[];
  /** Draw the skill's own name and grade. The chip-opened drawer puts those in its header instead. */
  header?: boolean;
}

export function SkillRubricPanel({ skill, findings, header = false }: SkillRubricPanelProps) {
  const styles = useStyles();

  // A new skill opens on its rubric: the tab the last one was left on is not a choice about this one.
  const [picked, setPicked] = useState<{ id?: string; tab: 'rubric' | 'files' }>({ tab: 'rubric' });
  const tab = picked.id === skill?.id ? picked.tab : 'rubric';
  const setTab = (next: 'rubric' | 'files') => setPicked({ id: skill?.id, tab: next });

  if (!skill) {
    return <Body1>This component has no skill rubric in the stored review.</Body1>;
  }

  const percent = skillScorePercent(skill);
  const weakest = weakestDimension(skill);
  const files = skill.sourceFiles ?? skill.files ?? [];

  return (
    <div className={styles.panel}>
      {header ? <SkillTitleLine skill={skill} /> : null}

      <div className={styles.factLine}>
        {percent === null ? null : (
          <>
            <Caption1 className={styles.fact}>
              <Caption1Strong>Quality:</Caption1Strong> {percent}%
            </Caption1>
            <span className={styles.factDivider}>|</span>
          </>
        )}
        <Caption1>{skill.sizeLabel}</Caption1>
        <span className={styles.factDivider}>|</span>
        <Caption1 className={styles.fact}>
          {skill.safetyFlagged
            ? <><ShieldErrorRegular className={styles.unsafe} /> Safety scan flagged</>
            : <><ShieldCheckmarkRegular className={styles.safe} /> Safety scan clean</>}
        </Caption1>
        {weakest ? (
          <>
            <span className={styles.factDivider}>|</span>
            <Caption1>
              Weakest: {dimensionLabel(weakest.key)} {normalizedDimensionScore(weakest.score)}/10
            </Caption1>
          </>
        ) : null}
      </div>

      {skill.description ? (
        <div className={styles.block}>
          <Caption1 className={styles.label}>Description</Caption1>
          <Body1>{skill.description}</Body1>
        </div>
      ) : null}

      <TabList selectedValue={tab} onTabSelect={(_, d) => setTab(d.value as 'rubric' | 'files')}>
        <Tab value="rubric">Rubric</Tab>
        <Tab value="files">Files ({files.length})</Tab>
      </TabList>

      {tab === 'rubric' ? (
        <>
          {findings && findings.length ? (
            <CollapsibleSection label="Findings" meta={findings.length}>
              <FindingsTable rows={findings} titleLabel="Check" />
            </CollapsibleSection>
          ) : null}

          <CollapsibleSection label="Bundle scores" meta={4}>
            <div className={styles.rows}>
              <QualifiedRow label="Instruction quality" score={skill.scores?.quality} />
              <QualifiedRow label="Bundle integrity" score={skill.scores?.integrity} />
              <QualifiedRow label="Resource safety" score={skill.scores?.safety} />
              <QualifiedRow label="Operational readiness" score={skill.scores?.readiness} />
            </div>
          </CollapsibleSection>

          <CollapsibleSection label="AI evaluations" meta={skill.dimensions.length || undefined}>
            {skill.dimensions.length ? (
              <div className={styles.rows}>
                {skill.dimensions.map(d => {
                  const score = normalizedDimensionScore(d.score);
                  return (
                    <div key={d.key} className={styles.row}>
                      <div className={styles.rowHead}>
                        <Caption1>{dimensionLabel(d.key)}</Caption1>
                        <Body1Strong className={styles.rowValue}>{score}/10</Body1Strong>
                      </div>
                      <ScoreBar percent={score * 10} tone={dimensionBand(d.score)} />
                      <Caption1 className={styles.rationale}>{d.rationale}</Caption1>
                    </div>
                  );
                })}
              </div>
            ) : (
              <Caption1 className={styles.label}>
                {skill.evaluationMessage ?? 'This skill was not evaluated by the model.'}
              </Caption1>
            )}
          </CollapsibleSection>
        </>
      ) : (
        <SkillFiles key={skill.id} skill={skill} />
      )}
    </div>
  );
}
