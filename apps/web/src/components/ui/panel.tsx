import type { CardProps } from '@fluentui/react-components';

import { fluentComponents } from '../../fluent';

const { Card, mergeClasses } = fluentComponents;

// `content` is the ordinary page-level surface; `flush` is the one that holds a
// table or a scrolling pane, whose own rows already reach the edge a padding
// would push them away from. The inset itself lives in `uno.css` as
// `--floway-panel-inset`, so it and the page inset step down together.
const PADDING_CLASS = {
  content: '!p-[var(--floway-panel-inset)]',
  flush: '!p-0',
} as const;

export type PanelProps = CardProps & { padding?: keyof typeof PADDING_CLASS };

// A Card, and nothing else beyond its inset. The WinUI layer gives every card
// the overlay corner radius, so a panel has no radius to state; the one surface
// that wants a larger one states it at its own call site.
//
// `Card` resets `display` and `gap` on itself, and Griffel's sheet is injected
// after the utility sheet at the same specificity, so a call site that wants a
// different layout or a different gap has to say so with `!` — an unprefixed
// `grid` or `gap-*` here is in the DOM and changes nothing.
export function Panel({ className, padding = 'content', ...props }: PanelProps) {
  return <Card {...props} className={mergeClasses(PADDING_CLASS[padding], className)} />;
}
