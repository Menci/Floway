import type { CardProps } from '@fluentui/react-components';

import { fluentComponents } from '../../fluent';

const { Card, mergeClasses } = fluentComponents;

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
