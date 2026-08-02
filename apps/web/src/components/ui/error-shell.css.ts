// The error page's geometry. Every box here is a layout box -- none paints a
// colour, takes a pointer or holds focus -- so the theme and forced-colours
// answers belong to the Fluent components inside them, and the metrics taken
// from WinUI carry the same value in all three of ContentDialog's theme
// dictionaries.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L3-L56
export const errorShellCss = `
  /* Blocks separated by the 24px ContentDialogPadding step
     ../../winui/controls/dialog.css.ts already puts between a dialog's body and
     its command band. The measure and the inset are ours: a page that has to
     hold a stack trace is not a 548px dialog.
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
  /* A grid item's automatic minimum is its content, which a long trace would
     spend on widening the page; these two hold every block inside the measure
     above. The selector weighs one class, so a Griffel atom injected later takes
     the tie. */
  .floway-error-shell > * { min-width: 0; max-width: 100%; }
  /* Sized to the window rather than to the document, which does not scroll. */
  .floway-error-shell-viewport { height: 100dvh; }
  /* The failure is stated as a page heading, not as a dialog's title, so it
     takes ./dashboard-page-header.tsx's step rather than
     ContentDialogTitleMargin's 12.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L17 */
  .floway-error-shell-stack { display: grid; gap: 6px; }
  .floway-error-shell-stack > * { margin: 0; }
  /* ContentDialogButtonSpacing between the commands, but they keep their
     content width instead of stretching across equal star columns as WinUI's
     CommandSpace does: that band closes a bounded dialog, while this row sits in
     an open page and reads as two offered commands rather than a page footer.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L16
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L248-L258 */
  .floway-error-shell-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
`;
