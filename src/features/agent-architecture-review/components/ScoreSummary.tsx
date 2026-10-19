/**
 * The score header from the review detail design (Figma `8882:28395`).
 *
 * A letter tile, then a colour-accent bar carrying the caption and the score. The tile, the bar and
 * the number all take the grade's colour, so the whole block reads as one verdict rather than as a
 * number with a decoration beside it.
 *
 * Figma pins one state — B+ in green — and names its fill `Global.Color.LightGreen.Tint60` against
 * `Green Tile` text. That is exactly Fluent's palette construction, so the tiers below use the
 * palette tokens rather than copied hexes: the green pair is the same colour the design asks for,
 * and the other three stay on the design system as the theme moves.
 */

import { Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { Grade } from '../models/review';

const useStyles = makeStyles({
  root: {
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
  },
  tile: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '73px',
    height: '67px',
    borderRadius: '12px',
    flexShrink: 0,
  },
  letter: {
    fontSize: '40px',
    lineHeight: '56px',
    fontWeight: tokens.fontWeightSemibold,
  },
  // The bar stretches to the block's height rather than a fixed one, so a wrapped caption keeps it
  // aligned with the text it accents.
  bar: {
    width: '4px',
    alignSelf: 'stretch',
    flexShrink: 0,
    borderRadius: '2px',
  },
  body: { display: 'flex', gap: tokens.spacingHorizontalS },
  text: { display: 'flex', flexDirection: 'column', justifyContent: 'center' },
  caption: {
    fontSize: '12px',
    lineHeight: '16px',
    color: tokens.colorNeutralForeground1,
  },
  subCaption: {
    fontSize: '10px',
    lineHeight: '14px',
    color: tokens.colorNeutralForeground2,
  },
  number: { display: 'flex', alignItems: 'baseline' },
  score: {
    fontSize: '28px',
    lineHeight: '36px',
    fontWeight: tokens.fontWeightBold,
  },
  outOf: {
    fontSize: '28px',
    lineHeight: '36px',
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },

  excellentTile: { backgroundColor: tokens.colorPaletteGreenBackground1 },
  excellentInk: { color: tokens.colorPaletteGreenForeground1 },
  excellentBar: { backgroundColor: tokens.colorPaletteGreenForeground1 },
  goodTile: { backgroundColor: tokens.colorPaletteGreenBackground1 },
  goodInk: { color: tokens.colorPaletteGreenForeground1 },
  goodBar: { backgroundColor: tokens.colorPaletteGreenForeground1 },
  fairTile: { backgroundColor: tokens.colorPaletteYellowBackground1 },
  fairInk: { color: tokens.colorPaletteYellowForeground1 },
  fairBar: { backgroundColor: tokens.colorPaletteYellowForeground1 },
  poorTile: { backgroundColor: tokens.colorPaletteDarkOrangeBackground1 },
  poorInk: { color: tokens.colorPaletteDarkOrangeForeground1 },
  poorBar: { backgroundColor: tokens.colorPaletteDarkOrangeForeground1 },
  failingTile: { backgroundColor: tokens.colorPaletteRedBackground1 },
  failingInk: { color: tokens.colorPaletteRedForeground1 },
  failingBar: { backgroundColor: tokens.colorPaletteRedForeground1 },
  ungradedTile: { backgroundColor: tokens.colorNeutralBackground3 },
  ungradedInk: { color: tokens.colorNeutralForeground3 },
  ungradedBar: { backgroundColor: tokens.colorNeutralStroke1 },
});

type Tone = 'excellent' | 'good' | 'fair' | 'poor' | 'failing' | 'ungraded';

/**
 * Groups letters into colour families.
 *
 * A and B share green because the design pins B+ as green, and a grade cannot be shown as worse than
 * one below it.
 */
function toneFor(grade: Grade | null): Tone {
  if (!grade) return 'ungraded';
  if (grade.startsWith('A')) return 'excellent';
  if (grade.startsWith('B')) return 'good';
  if (grade.startsWith('C')) return 'fair';
  if (grade.startsWith('D')) return 'poor';
  return 'failing';
}

export interface ScoreSummaryProps {
  /** Null when the run produced no score; the block then says so instead of showing a zero. */
  score: number | null;
  grade: Grade | null;
  caption: string;
  subCaption?: string;
}

export function ScoreSummary({ score, grade, caption, subCaption }: ScoreSummaryProps) {
  const styles = useStyles();
  const tone = toneFor(grade);

  return (
    <div className={styles.root}>
      <div
        className={mergeClasses(styles.tile, styles[`${tone}Tile`])}
        aria-label={grade ? `Grade ${grade}` : 'Not yet graded'}
      >
        <Text className={mergeClasses(styles.letter, styles[`${tone}Ink`])}>{grade ?? '-'}</Text>
      </div>

      <div className={styles.body}>
        <div className={mergeClasses(styles.bar, styles[`${tone}Bar`])} />
        <div className={styles.text}>
          <Text className={styles.caption}>{caption}</Text>
          {subCaption ? <Text className={styles.subCaption}>{subCaption}</Text> : null}
          <div className={styles.number}>
            {score === null ? (
              <Text className={mergeClasses(styles.score, styles.ungradedInk)}>Not assessed</Text>
            ) : (
              <>
                <Text className={mergeClasses(styles.score, styles[`${tone}Ink`])}>{score}</Text>
                <Text className={styles.outOf}>/100</Text>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
