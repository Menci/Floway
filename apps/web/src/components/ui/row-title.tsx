import type { ComponentProps, ReactNode } from 'react';

import { fluentComponents } from '../../fluent';

const { mergeClasses } = fluentComponents;

// A row's own name, whether it navigates or opens the row in place. It is not a
// link: WinUI's HyperlinkButton is accent-foreground at rest, pointer-over and
// pressed, and states no text decoration of its own, so a hyperlink treatment
// would repaint the name of every row an accent it does not own.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/HyperlinkButton_themeresources.xaml#L5-L8
//
// The name therefore keeps the body foreground and takes its underline only
// under the pointer, over the app's focus rect.
//
// Paint only. The box is the cell's business: one site truncates through its
// `TableCellLayout`, the other through the element itself.
export const rowTitleClass = 'winui-focus-rect text-fui-fg1 no-underline hover:underline';

// A `button` rather than an anchor. The row it opens does have an address --
// the upstream editor names the selected model in its search params -- but that
// address is a position inside one editing session, and a second tab on it is a
// second editor competing over the same record rather than a second view of
// anything. What earns an anchor is a view a reader would want beside another.
//
// The leading is stated because truncation brings `overflow: hidden` with it,
// and a button's own line box is tight enough to clip a descender. The sibling
// cell that truncates a model id states the same step for the same reason.
// Fluent clones a Tooltip's trigger element, so any prop this button drops --
// the ref, the pointer and focus handlers, the aria attribute tying the two
// together -- leaves the tooltip with nothing to open on.
type RowTitleTriggerProps = Omit<ComponentProps<'button'>, 'children' | 'className' | 'onClick' | 'type'>;

export function RowTitleButton({ children, onClick, ...trigger }: {
  children: ReactNode;
  onClick: () => void;
} & RowTitleTriggerProps) {
  return <button className={mergeClasses(rowTitleClass, 'block bg-transparent border-0 cursor-pointer leading-[var(--lineHeightBase300)] min-w-0 max-w-full truncate p-0 text-fui-base300 text-left')} onClick={onClick} type="button" {...trigger}>
    {children}
  </button>;
}
