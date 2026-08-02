import type { ReactNode } from 'react';

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

// A `button` rather than an anchor: this one opens the row where it stands, so
// there is no address to carry and nothing for a new tab to open.
export function RowTitleButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return <button className={`${rowTitleClass} block bg-transparent border-0 cursor-pointer min-w-0 max-w-full truncate p-0 text-fui-base300 text-left`} onClick={onClick} type="button">
    {children}
  </button>;
}
