// Pure layout boxes: nothing here paints, takes a pointer or holds focus, so
// theme and forced-colours answers belong to the Fluent components inside, and
// the WinUI metrics below hold in all three ContentDialog theme dictionaries.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L3-L56
export const errorShellCss = `
  /* 24px is ContentDialogPadding; the measure and the inset are ours, since a
     page that has to hold a stack trace is not a 548px dialog. The shell's own
     min-height of max-content is what keeps a long trace scrolling, where the
     full height beside it would clamp the shell to the viewport.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L18 */
  .floway-error-shell {
    display: grid;
    align-content: center;
    justify-items: center;
    gap: 24px;
    height: 100%;
    min-height: max-content;
    margin: 0 auto;
    max-width: 720px;
    padding: 64px 24px;
  }
  /* A grid item's automatic minimum is its content, so without these a long
     trace widens the page past the measure above. */
  .floway-error-shell > * { min-width: 0; max-width: 100%; }
  .floway-error-shell-viewport { height: 100dvh; }
  /* A page heading, not a dialog title: takes ./dashboard-page-header.tsx's
     step rather than ContentDialogTitleMargin's 12.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L17 */
  .floway-error-shell-stack { display: grid; gap: 6px; }
  .floway-error-shell-stack > * { margin: 0; }
  /* ContentDialogButtonSpacing, but content-width instead of WinUI
     CommandSpace's equal star columns: this row sits in an open page and reads
     as two offered commands rather than as a page footer closing a dialog.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L16
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L248-L258 */
  .floway-error-shell-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
`;
