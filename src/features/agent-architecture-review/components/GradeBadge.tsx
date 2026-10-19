/**
 * Colour-coded letter grade avatar, as used in the landing grid, the results
 * timeline, and beside the score on a report.
 *
 * Colours are the `Transparency/Slot` variables read from the Figma file rather
 * than hand-picked approximations. They are deliberately pastel, so the letter
 * is drawn in the neutral foreground: white text on these backgrounds would fail
 * contrast.
 *
 * The letter is passed in, never derived here — `gradeForScore` in the review
 * model owns the bands, so every surface reaches the same letter for a score.
 */

import { Text, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { Grade } from '../models/review';

/** Figma `Transparency/Slot N`, ordered best to worst. */
const GRADE_COLORS = {
  excellent: '#5EC75A',
  good: '#A4CC6C',
  fair: '#DAC157',
  poor: '#E0A96D',
  failing: '#DF8E64',
} as const;

const useStyles = makeStyles({
  badge: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '32px',
    height: '32px',
    borderRadius: tokens.borderRadiusCircular,
    padding: `0 ${tokens.spacingHorizontalXS}`,
    color: tokens.colorNeutralForeground1,
  },
  large: {
    minWidth: '40px',
    height: '40px',
    fontSize: tokens.fontSizeBase400,
  },
  excellent: { backgroundColor: GRADE_COLORS.excellent },
  good: { backgroundColor: GRADE_COLORS.good },
  fair: { backgroundColor: GRADE_COLORS.fair },
  poor: { backgroundColor: GRADE_COLORS.poor },
  failing: { backgroundColor: GRADE_COLORS.failing },
  empty: {
    backgroundColor: tokens.colorNeutralBackground5,
    color: tokens.colorNeutralForeground3,
  },
});

/** Groups letters into the four colour families used in the design. */
function toneFor(grade: Grade): 'excellent' | 'good' | 'fair' | 'poor' | 'failing' {
  if (grade.startsWith('A')) return 'excellent';
  if (grade.startsWith('B')) return 'good';
  if (grade.startsWith('C')) return 'fair';
  if (grade.startsWith('D')) return 'poor';
  return 'failing';
}

export interface GradeBadgeProps {
  grade: Grade | null;
  size?: 'medium' | 'large';
}

export function GradeBadge({ grade, size = 'medium' }: GradeBadgeProps) {
  const styles = useStyles();

  if (!grade) {
    return (
      <span
        className={mergeClasses(styles.badge, size === 'large' && styles.large, styles.empty)}
        aria-label="Not yet graded"
      >
        <Text weight="semibold">-</Text>
      </span>
    );
  }

  return (
    <span
      className={mergeClasses(styles.badge, size === 'large' && styles.large, styles[toneFor(grade)])}
      aria-label={`Grade ${grade}`}
    >
      <Text weight="semibold">{grade}</Text>
    </span>
  );
}
