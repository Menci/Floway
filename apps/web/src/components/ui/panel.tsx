import type { CardProps } from '@fluentui/react-components';

import { fluentComponents } from '../../fluent';

const { Card, mergeClasses } = fluentComponents;

// A panel's own inset, exported for the bodies a flush panel wraps: a scrolling
// region has to reach the panel's edges, so its content states the inset the
// panel would otherwise have applied. Written out again below rather than
// composed, because UnoCSS extracts class names from the source text and never
// sees a name assembled at runtime.
export const PANEL_INSET_CLASS = 'p-[var(--floway-panel-inset)]';

const PADDING_CLASS = {
  content: '!p-[var(--floway-panel-inset)]',
  flush: '!p-0',
} as const;

export type PanelProps = CardProps & { padding?: keyof typeof PADDING_CLASS };

// Griffel's sheet is injected after the utility sheet at the same specificity, so
// a utility overriding a `Card` style — padding, display, gap — needs `!` to win.
export function Panel({ className, padding = 'content', ...props }: PanelProps) {
  return <Card {...props} className={mergeClasses(PADDING_CLASS[padding], className)} />;
}
