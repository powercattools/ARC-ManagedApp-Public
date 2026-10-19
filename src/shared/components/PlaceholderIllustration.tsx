/**
 * Neutral placeholder artwork for the landing empty state.
 *
 * The empty state has not been designed yet, so this stands in until the real
 * illustration lands. It is deliberately built from Fluent tokens rather than a
 * raster asset so it themes correctly and adds nothing to the bundle payload.
 *
 * Decorative only — `EmptyState` already carries the accessible text, so this is
 * hidden from assistive technology.
 */

import { tokens } from '@fluentui/react-components';

export interface PlaceholderIllustrationProps {
  className?: string;
}

export function PlaceholderIllustration({ className }: PlaceholderIllustrationProps) {
  return (
    <svg
      className={className}
      width="160"
      height="120"
      viewBox="0 0 160 120"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <ellipse cx="80" cy="103" rx="54" ry="8" fill={tokens.colorNeutralBackground3} />

      <rect
        x="38"
        y="16"
        width="84"
        height="80"
        rx="8"
        fill={tokens.colorNeutralBackground1}
        stroke={tokens.colorNeutralStroke2}
        strokeWidth="2"
      />

      <rect x="54" y="36" width="52" height="6" rx="3" fill={tokens.colorNeutralStroke2} />
      <rect x="54" y="50" width="40" height="6" rx="3" fill={tokens.colorNeutralStroke2} />
      <rect x="54" y="64" width="46" height="6" rx="3" fill={tokens.colorNeutralStroke2} />

      <circle
        cx="112"
        cy="82"
        r="18"
        fill={tokens.colorBrandBackground2}
        stroke={tokens.colorNeutralBackground1}
        strokeWidth="3"
      />
      <path
        d="M105 82.5 L110 87.5 L119.5 77"
        stroke={tokens.colorBrandForeground2}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
