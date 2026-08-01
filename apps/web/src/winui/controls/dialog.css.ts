// Dialog, restyled from Fluent 2 Web onto WinUI 3's ContentDialog.
//
// The two libraries lay the same dialog out differently. Fluent puts the 24px
// padding on the surface and separates title, content, and actions with an 8px
// grid gap, so the actions sit inside the padding as a right-aligned flex row.
// WinUI puts the padding on two full-bleed bands instead: a content band and a
// CommandSpace band beneath it, divided by a 1px separator, with the buttons
// laid out in equal star-width columns. Reproducing that means moving the
// padding from the surface onto the body and letting the actions row break
// back out of it, which is what the negative insets below do.
//
// The foundation layer already remaps Fluent's neutral ramp, radii, and
// typography, so agreements it establishes -- the 8px OverlayCornerRadius, the
// 1px border, the 20px semibold title, the 8px button spacing -- carry no rule
// here.
//
// WinUI fills the content band with ContentDialogTopOverlay, which resolves to
// LayerFillColorAltBrush -- opaque white in light, a five percent white wash in
// dark. That is what makes a Windows dialog read as a light sheet over a grey
// frame rather than as one flat grey box: the band carries the layer fill, the
// CommandSpace beneath it shows the dialog's own background, and the separator
// divides them.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L8
export const dialogCss = `
/* The surface is WinUI's BackgroundElement: the solid base fill rather than
   Fluent's raised Background1, the surface stroke rather than a transparent
   one, and BackgroundSizing="InnerBorderEdge", which is background-clip:
   padding-box on the web, so the translucent border reads against the smoke
   layer behind it instead of against its own fill. WinUI states the whole size
   envelope on BackgroundElement -- 320 minimum width, 548 maximum, 184 minimum
   height, 756 maximum -- where Fluent states only a maximum width. The height
   cap is additionally bounded by the viewport, as the XAML one is bounded by
   the window, and is exposed as one variable so the body can consume exactly
   the same envelope. The surface never scrolls; DialogShell gives its middle
   grid row to OverlayScrollbars.

   ContentDialogMaxWidth is a keyed ThemeResource that an app overrides in its
   own dictionary, so a custom property with a 548px fallback is the faithful
   shape rather than a loosening of it. The alias editor and the API key editor
   set it to 720px, because both carry settings rows laid out for a full-width
   settings page.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L6-L15
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L223 */
.fui-DialogSurface.fui-DialogSurface {
  --floway-dialog-max-height: min(756px, 100dvh);
  padding: 0;
  background-color: var(--winui-solid-background-fill-base);
  border-color: var(--winui-surface-stroke-default);
  background-clip: padding-box;
  min-width: 320px;
  max-width: var(--floway-dialog-max-width, 548px);
  min-height: 184px;
  max-height: var(--floway-dialog-max-height);
  overflow: hidden;
}

/* Fluent moves overflow onto the whole surface below 360px and reserves that
   browser scrollbar by widening three border edges to 4px. DialogShell keeps
   the same three-band grid at every height, so neither the native scroll path
   nor its compensating border survives; only the middle OverlayScrollbars
   viewport contracts. The scroll path is already cancelled by the surface rule
   above, which outranks Fluent's overflow-y at every height, so only the border
   is restated here. */
@media (max-height: 359px) {
  .fui-DialogSurface.fui-DialogSurface {
    border-width: 1px;
  }
}

/* Focus. Fluent draws its ring as an ::after inset 2px outside the surface and
   blanks the surface border while it shows; WinUI's ring is the outer stroke
   with the inner stroke against the control, both following the control's own
   corner radius rather than Fluent's medium one. The ::after box is 2px larger
   on every side than the surface it traces, so staying concentric with the
   8px overlay corner means rounding it by that much more.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L66 */
.fui-DialogSurface.fui-DialogSurface[data-fui-focus-visible] {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
  border-color: var(--winui-focus-stroke-inner);
}

.fui-DialogSurface.fui-DialogSurface[data-fui-focus-visible]::after {
  border-radius: calc(var(--winui-overlay-corner-radius) + 2px);
}

/* The body takes over the 24px ContentDialogPadding the surface gave up, and
   drops Fluent's 8px gap: WinUI's bands abut, and the step under the title is
   a margin on the title itself. The height cap sits here rather than on the
   surface, less the 1px ContentDialogBorderWidth on each end, because the body
   now fills the surface edge to edge and the surface does not clip.
   ContentDialogMinHeight belongs to BackgroundElement and is stated there.
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

/* The form is a semantic wrapper around Fluent's grid root. It must transmit
   the surface envelope without becoming a fourth sizing or scroll owner. */
.floway-dialog-shell__form {
  margin: 0;
  max-height: inherit;
  min-height: 0;
  overflow: hidden;
}

/* Fluent normally makes DialogContent the browser-scroll viewport. Here it is
   only the minmax grid cell around ScrollArea: doubled class specificity keeps
   Griffel's runtime-injected overflow-y:auto from winning by stylesheet order.
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-dialog/library/src/components/DialogContent/useDialogContentStyles.styles.ts#L16-L31 */
.fui-DialogContent.fui-DialogContent {
  min-height: 0;
  overflow: hidden;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L17 */
.fui-DialogTitle.fui-DialogTitle {
  margin-bottom: 12px;
}

/* CommandSpace. It spans the dialog whatever the actions' position prop says,
   breaks out of the body's padding through matching negative insets so it
   reaches the surface edge, and restates the separator as a top border,
   because the band above it is not a single element on this side. The buttons
   take equal star-width columns and stretch, where Fluent sizes them to their
   content.
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
   width ahead of it, so it takes the right half of the band. fluent-svelte
   reaches the same layout from a single-column grid, and that technique --
   including its narrowing to a button, so a spinner or a wrapper element is
   not half-width by accident -- is taken here.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ContentDialog_themeresources.xaml#L250-L256 */
.fui-DialogActions > .fui-Button.fui-Button:only-child {
  width: 50%;
  justify-self: end;
}

/* Narrow viewports. WinUI's CommandSpace declares no width trigger, so its
   star-width buttons stay side by side however narrow the window gets; Fluent
   breaks them into a column at 480px and that break is kept here as our own
   call for small viewports. Fluent expresses it as flex-direction, which is
   inert under the display: grid above, so it is restated as a row flow. Equal
   columns become equal rows, and the lone button gives up its half of the band
   because no second column is left for it to yield to.
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
