import type { CardProps } from '@fluentui/react-components';

import { fluentComponents } from '../../fluent';

const { Card, mergeClasses } = fluentComponents;

// `flush` is for a table or scrolling pane whose own rows already reach the edge
// a padding would push them away from. The inset lives in `global.css` so it and
// the page inset step down together.
const PADDING_CLASS = {
  content: '!p-[var(--floway-panel-inset)]',
  flush: '!p-0',
} as const;

export type PanelProps = CardProps & { padding?: keyof typeof PADDING_CLASS };

// `Card` resets `display` and `gap` on itself, and Griffel's sheet is injected
// after the utility sheet at the same specificity, so a call site wanting a
// different layout or gap has to say so with `!` — an unprefixed `grid` or
// `gap-*` reaches the DOM and changes nothing.
export function Panel({ className, padding = 'content', ...props }: PanelProps) {
  return <Card {...props} className={mergeClasses(PADDING_CLASS[padding], className)} />;
}
