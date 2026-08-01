// The error page's geometry: the shell that centres it, the sentence stack at
// its top, and the row of commands under both. Every box here is a layout box
// -- none of them paints a colour, takes a pointer or holds focus -- so each
// has a single state. The theme and forced-colours answers belong to the
// Fluent components arranged inside them, and the metrics this file does take
// from WinUI carry the same value in all three of ContentDialog's theme
// dictionaries, Default, Light and HighContrast alike.
//
// It is stated as plain CSS in the inlined critical block, beside the boot
// screen this page replaces and the canvas both are drawn on. Those two are
// painted by the prerendered index.html before any module has run and have to
// be there; this one is there so the app's chromeless full-window surfaces are
// described together and in the same terms.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L3-L56
export const errorShellCss = `
  /* The page. Its blocks -- statement, trace, commands -- are separated by the
     24px ContentDialogPadding step ../../winui/controls/dialog.css.ts already
     puts between a dialog's body and its command band. The measure and the
     inset are ours: a page that has to hold a stack trace is not a 548px
     dialog, and the trace is what the inset leaves room to scroll past.
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
     above. The selector weighs one class, so a Griffel atom injected later
     takes the tie -- nothing here is asked of a Fluent-rooted child. */
  .floway-error-shell > * { min-width: 0; max-width: 100%; }
  /* The scroller the shell fills, sized to the window rather than to the
     document, which does not scroll. */
  .floway-error-shell-viewport { height: 100dvh; }
  /* Title and message, on the step ./dashboard-page-header.tsx puts between a
     page's title and its description, from the same h1 at the same size: the
     failure is stated as a page heading, not as a dialog's title, so it takes
     the page heading's spacing rather than ContentDialogTitleMargin's 12.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L17 */
  .floway-error-shell-stack { display: grid; gap: 6px; }
  .floway-error-shell-stack > * { margin: 0; }
  /* ContentDialogButtonSpacing between the commands. They keep their content
     width and centre under the statement, where WinUI's CommandSpace stretches
     its buttons across equal star columns: that band spans a bounded dialog
     and closes it, while this row sits in an open page under a centred
     sentence, so the pair reads as two offered commands rather than as the
     page's own footer. Wrapping is the same call at a narrow window that
     ../../winui/controls/dialog.css.ts makes by breaking CommandSpace into
     rows.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L16
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L248-L258 */
  .floway-error-shell-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
`;
