// Dialog, restyled from Fluent 2 Web onto WinUI 3's ContentDialog.
//
// Fluent puts the 24px padding on the surface; WinUI puts it on two full-bleed
// bands -- a content band carrying the layer fill and a CommandSpace showing the
// dialog's own background, divided by a 1px separator. Reaching that means the
// padding moves onto the body and the actions row breaks back out of it, which
// is what the negative insets below do.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L8
export const dialogCss = `
/* The height cap is exposed as one variable so the body can consume exactly the
   same envelope. ContentDialogMaxWidth is a keyed ThemeResource an app overrides
   in its own dictionary, so a custom property with a 548px fallback is the
   faithful shape; the alias, API key, and user editors raise it to an unsourced
   720px.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L6-L15
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L223 */
.fui-DialogSurface.fui-DialogSurface {
  --floway-dialog-max-height: min(756px, 100dvh);
  padding: 0;
  background-color: var(--winui-solid-background-fill-base);
  border-color: var(--winui-surface-stroke-default);
  min-width: 320px;
  max-width: var(--floway-dialog-max-width, 548px);
  min-height: 184px;
  max-height: var(--floway-dialog-max-height);
  overflow: hidden;
}

/* Fluent moves overflow onto the whole surface here and widens three border
   edges to 4px to reserve the browser scrollbar. DialogShell keeps its
   three-band grid at every height, so only the border needs restating. */
@media (max-height: 359px) {
  .fui-DialogSurface.fui-DialogSurface {
    border-width: 1px;
  }
}

/* WinUI doubles the stroke to 2px because the smoke layer and the dialog
   collapse onto the same system Window colour; forced colours collapse the same
   two fills but leave widths alone.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L21-L28
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
@media (forced-colors: active) {
  .fui-DialogSurface.fui-DialogSurface {
    border-width: 2px;
  }
}

/* Fluent draws its focus ring two pixels outside the surface and blanks the
   surface border while it shows. The surface clip is the outermost box of the
   overlay, so a ring outside it is invisible: both strokes move indoors, and the
   blanked border takes back its rest stroke.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L66 */
.fui-DialogSurface.fui-DialogSurface[data-fui-focus-visible] {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
  border-color: var(--winui-surface-stroke-default);
}

.fui-DialogSurface.fui-DialogSurface[data-fui-focus-visible]::after {
  inset: 0;
  border-radius: calc(var(--winui-overlay-corner-radius) - 1px);
  box-shadow: inset 0 0 0 1px var(--winui-focus-stroke-inner);
}

/* The body takes over the 24px ContentDialogPadding the surface gave up, and
   drops Fluent's gap: WinUI's bands abut, and the step under the title is a
   margin on the title itself. The cap sits here, less the 1px border on each
   end, because the body fills the surface edge to edge.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L18
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L228-L233 */
.fui-DialogBody.fui-DialogBody {
  padding: 24px;
  gap: 0;
  background-color: var(--winui-layer-fill-alt);
  border-radius: var(--winui-overlay-corner-radius) var(--winui-overlay-corner-radius) 0 0;
  grid-template-rows: auto minmax(0, 1fr) auto;
  max-height: calc(var(--floway-dialog-max-height) - 2px);
  min-height: 0;
  overflow: hidden;
}

/* The form must transmit the surface envelope without becoming a fourth sizing
   or scroll owner. */
.floway-dialog-shell__form {
  margin: 0;
  max-height: inherit;
  min-height: 0;
  overflow: hidden;
}

/* Fluent normally makes DialogContent the browser-scroll viewport. Here it is
   only the minmax grid cell around ScrollArea: doubled class specificity keeps
   Griffel's runtime-injected overflow-y:auto from winning by stylesheet order.

   Fluent also spends that cell's padding on a focus gutter, with an equal
   negative margin putting the text back on the title's edge. The gutter has to
   move inside the scrollport -- a scrollport clips at its own edge, so padding
   outside it does not hold an overhang -- but the outset stays here, and stays
   the same length, because WinUI lays Title and Content out in one Grid under a
   single ContentDialogPadding: the content has no inset the title lacks, in
   either axis. The length is FocusVisualMargin, the 3px a WinUI focus visual is
   drawn outside the control it belongs to.
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-dialog/library/src/components/DialogContent/useDialogContentStyles.styles.ts#L16-L31
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L233-L246
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L167 */
.fui-DialogContent.fui-DialogContent {
  --floway-dialog-focus-gutter: 3px;
  padding: 0;
  margin: 0 calc(-1 * var(--floway-dialog-focus-gutter));
  min-height: 0;
  overflow: hidden;
}

/* ContentDialog presents its content with TextWrapping="Wrap", which breaks
   inside a word rather than letting an over-long one out of the dialog; the
   messages here name user-chosen upstreams, aliases and keys, and carry server
   text. 'anywhere' rather than 'break-word' because the content is a grid whose
   items would otherwise keep the unbroken word as their automatic minimum size
   and overflow the scrollport instead of wrapping in it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L246
   https://drafts.csswg.org/css-text-4/#overflow-wrap-property */
.floway-dialog-shell__scrollport {
  padding-inline: var(--floway-dialog-focus-gutter);
  overflow-wrap: anywhere;
}

/* ContentDialogTitleMargin, and the Title presenter's TextWrapping="Wrap" --
   several titles interpolate a user-chosen alias, key or username. Its
   MaxLines="2" is not transcribed: XAML clips the rest with nothing to reveal
   it, and the surface here can afford the line.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L17
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L241 */
.fui-DialogTitle.fui-DialogTitle {
  margin-bottom: 12px;
  overflow-wrap: anywhere;
}

/* CommandSpace spans the dialog whatever the actions' position prop says, breaks
   out of the body's padding through matching negative insets, and restates the
   separator as a top border because the band above it is not a single element on
   this side. The buttons take equal star-width columns, where Fluent sizes them
   to their content.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L248-L258
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L10-L19 */
.fui-DialogActions.fui-DialogActions {
  grid-column: 1 / -1;
  justify-self: stretch;
  width: auto;
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  justify-items: stretch;
  margin: 24px -24px -24px;
  padding: 24px;
  background-color: var(--winui-solid-background-fill-base);
  border-top: 1px solid var(--winui-card-stroke-default);
  border-radius: 0 0 var(--winui-overlay-corner-radius) var(--winui-overlay-corner-radius);
}

/* A lone button lands in WinUI's CloseColumn with PrimaryColumn still at star
   width ahead of it and the 8px SecondSpacer between the two, so it takes half
   of what the band leaves after that gap. The selector names the button's own
   class rather than the element, so a spinner or a wrapper is not half-width by
   accident.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L250-L256 */
.fui-DialogActions > .fui-Button.fui-Button:only-child {
  width: calc(50% - 4px);
  justify-self: end;
}

/* WinUI's CommandSpace declares no width trigger, so its star-width buttons stay
   side by side however narrow the window gets; Fluent's 480px break into a
   column is deliberately kept. Fluent expresses it as flex-direction, inert
   under the display: grid above, so it is restated as a row flow.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L248-L258 */
@media (max-width: 480px) {
  .fui-DialogActions.fui-DialogActions {
    grid-auto-flow: row;
  }

  .fui-DialogActions > .fui-Button.fui-Button:only-child {
    width: auto;
    justify-self: stretch;
  }
}
`;
