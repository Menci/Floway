// MessageBar, restyled from Fluent 2 Web onto WinUI 3.
//
// InfoBar is the counterpart, and its theme resources are a flat dictionary of
// metrics and severity brushes with no VisualStateManager in them: WinUI gives
// an InfoBar no hover, pressed, disabled or focus appearance. Every rule below
// is therefore a rest rule, and the only interactive part in the control is the
// close button, whose chrome InfoBarCloseButtonStyle inherits wholesale from
// DefaultButtonStyle — so this file sizes that button and leaves its fill,
// stroke, radius and states to controls/button.css.ts.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L88-L95
//
// InfoBar has a second layout — WinUI calls it vertical orientation, Fluent
// calls it `layout: 'multiline'` — and it is reachable here despite being
// JS-merged with no data attribute: Fluent renders the `bottomReflowSpacer`
// slot only in that layout, so `:has(> .fui-MessageBar__bottomReflowSpacer)`
// names it structurally. The vertical-orientation metrics are transcribed in
// the last section of this file.
//
// The severity fill is the most visible thing InfoBar has, and it is reached
// through `data-winui-intent`, which the runtime chokepoint stamps with the
// resolved intent. Fluent composes `rootIntentStyles[state.intent]` and
// `iconIntentStyles[state.intent]` in JavaScript and writes nothing a selector
// could name, so the stamp is what makes the four severities addressable at
// all; the same chokepoint swaps in the filled counterpart of each glyph.
//
// That filled glyph carries one half of WinUI's two-layer construction. InfoBar
// stacks two TextBlocks in the same cell: InfoBarIconBackgroundGlyph, a disc in
// the severity colour, under the severity symbol painted in
// TextFillColorInverse. A Fluent `*Filled` circle icon is one path with the
// symbol as negative space — the same silhouette with the layers inverted — so
// the icon rule below paints the inverse layer as a disc behind it, and what
// shows through the knock-out is the colour WinUI states.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar.xaml#L107-L109
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L5-L16
//
// Two vertical-orientation terms stay unspent for a structural reason rather
// than a reachability one. InfoBarTitleVerticalOrientationMargin and
// InfoBarMessageVerticalOrientationMargin measure a block gap between a title
// and a message sitting on their own lines, which is how WinUI's panel stacks
// them; Fluent keeps title and message inline in one wrapping body flow in
// every layout, so there is no such gap to set.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L82
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L84
//
// The border, the radius and the body and title typography need no rule: the
// theme layer already points Fluent's neutral stroke, corner radius and type
// ramp at the values InfoBarBorderBrush, ControlCornerRadius and the
// InfoBar*FontSize/FontWeight keys resolve to. Only the one stroke that differs
// by family — the card stroke InfoBar picks over the control stroke — is
// restated, and only the dark theme sees it change.
export const messageBarCss = `
/* An InfoBar is a full pixel taller than a MessageBar and holds its content
   further off the leading edge. InfoBarContentRootPadding is the XAML thickness
   16,0,0,0, i.e. leading only, which is why this is padding-inline-start rather
   than a shorthand.

   The stroke is the one colour restated here, and it only bites in dark:
   InfoBar takes InfoBarBorderBrush from the card stroke family where Fluent's
   border reads the neutral control stroke, and the two families agree byte for
   byte in light (#0000000f) but not in dark (#00000019 against #ffffff12).
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L66
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L75
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L20 */
.fui-MessageBar.fui-MessageBar {
  min-height: 48px;
  padding-inline-start: 16px;
  border-color: var(--winui-card-stroke, var(--colorNeutralStroke1));
  /* A grid item's automatic minimum size is its content's, and for the
     single-line layout that is the whole message on one line. So a bar in a
     narrower column does not narrow: it overflows its track and widens
     everything laid out beside it, and Fluent's auto layout -- which watches
     the bar's width to decide when to reflow -- never observes the width that
     would make it reflow. Zeroing the floor lets the column size the bar, which
     is what both the wrap and the reflow were waiting for. */
  min-width: 0;
}

/* WinUI's glyph is smaller than Fluent's and is spaced by InfoBarIconMargin,
   the thickness 0,16,14,16. Its block terms are what pin the glyph to the first
   line of the message instead of to the middle of the bar, so align-self goes
   with them: 16 + 16 + 16 is InfoBarMinHeight, which makes the pinned position
   and Fluent's centred one the same position on a single-line bar and different
   ones exactly when the body wraps, the case the margin exists for. The margin
   is orientation-independent, so the multiline section below only has to stop
   Fluent's root padding stacking underneath it.

   The disc is the inverse layer of the two-glyph stack, carried as a background
   rather than as a second element because the negative-space glyph already
   supplies the severity-coloured layer over it. All four filled circle glyphs
   are an r=8 circle in a 20 unit box, so on a square 1em icon the disc is 80%
   of the closest side; the stops land just inside that edge so no ring escapes
   from under the glyph.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L13-L16
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L76
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L77 */
.fui-MessageBar__icon.fui-MessageBar__icon {
  align-self: start;
  font-size: 16px;
  margin-block: 16px;
  margin-inline-end: 14px;
  background: radial-gradient(
    closest-side,
    var(--winui-text-fill-inverse) 79%,
    transparent 80%
  );
}

/* Severity. Each of the four maps onto one SystemFillColor family: the bar
   takes its Background step and the glyph takes the plain one. Fluent's own
   intent styles tint a pale wash of the brand ramp and stroke the bar to match,
   so the stroke is held at the card stroke every severity shares.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L5-L12
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L20 */
.fui-MessageBar.fui-MessageBar[data-winui-intent='error'] {
  background-color: var(--winui-system-fill-critical-background);
}

.fui-MessageBar[data-winui-intent='error'] .fui-MessageBar__icon.fui-MessageBar__icon {
  color: var(--winui-system-fill-critical);
}

.fui-MessageBar.fui-MessageBar[data-winui-intent='warning'] {
  background-color: var(--winui-system-fill-caution-background);
}

.fui-MessageBar[data-winui-intent='warning'] .fui-MessageBar__icon.fui-MessageBar__icon {
  color: var(--winui-system-fill-caution);
}

.fui-MessageBar.fui-MessageBar[data-winui-intent='success'] {
  background-color: var(--winui-system-fill-success-background);
}

.fui-MessageBar[data-winui-intent='success'] .fui-MessageBar__icon.fui-MessageBar__icon {
  color: var(--winui-system-fill-success);
}

.fui-MessageBar.fui-MessageBar[data-winui-intent='info'] {
  background-color: var(--winui-system-fill-attention-background);
}

.fui-MessageBar[data-winui-intent='info'] .fui-MessageBar__icon.fui-MessageBar__icon {
  color: var(--winui-system-fill-attention);
}

/* InfoBarPanelMargin, the thickness 0,0,16,0, holds the text off whatever
   follows it — an action button, the close button, or the trailing edge.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L78 */
.fui-MessageBarBody.fui-MessageBarBody {
  padding-inline-end: 16px;
}

/* Fluent separates title from message with a single literal space emitted by
   an ::after; WinUI separates them with the 12px leading term of
   InfoBarMessageHorizontalOrientationMargin. Suppressing the space is half of
   one change, not a rule of its own — without it the margin would land on top
   of a gap that is still there.

   That thickness is 12,14,0,0 and InfoBarTitleHorizontalOrientationMargin is
   0,14,0,0; the shared 14px top term top-aligns the panel where Fluent centres
   it. We keep Fluent's centring: on the 48px bar those two placements agree to
   within a pixel for a single line of body text, and the wrapping case is the
   multiline layout, which has its own term below.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L81
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L83 */
.fui-MessageBarTitle.fui-MessageBarTitle {
  margin-inline-end: 12px;
}

.fui-MessageBarTitle.fui-MessageBarTitle::after {
  content: none;
}

/* The close button is a Button sized and inset by InfoBarCloseButtonStyle:
   38px square, a uniform 5px margin, and top alignment. Those are the terms
   that give the bar its height — 5 + 38 + 5 is InfoBarMinHeight — so the
   uniform margin is transcribed as padding on the slot that holds the button
   rather than dropped down to the button itself, where it would sit outside
   the grid area and stop contributing.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L88-L95 */
.fui-MessageBarActions__containerAction.fui-MessageBarActions__containerAction {
  align-self: start;
  padding: 5px;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L67 */
.fui-MessageBarActions__containerAction > .fui-Button.fui-Button {
  height: 38px;
  max-width: 38px;
  min-width: 38px;
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L68 */
.fui-MessageBarActions__containerAction > .fui-Button > .fui-Button__icon.fui-Button__icon {
  font-size: 16px;
  height: 16px;
  width: 16px;
}

/* Vertical orientation. Fluent gives the multiline root 10px of padding-top,
   which offsets every child; WinUI leaves InfoBarContentRootPadding at 16,0,0,0
   in both orientations and offsets the text panel alone. The root term is
   therefore zeroed and the panel carries its own block padding — otherwise the
   glyph would sit 26px down and the close button 15px down, where
   InfoBarIconMargin and InfoBarCloseButtonStyle put them at 16 and 5.

   InfoBarPanelVerticalOrientationPadding is 0,14,0,18. Fluent lifts the action
   buttons out of the body into a grid row of their own, so the trailing 18 is
   spent on that row rather than on the body: the actions row and the reflow
   spacer share one grid cell and both carry it, which leaves 18px below the
   last content whether or not there are actions, since Fluent hides the actions
   row outright when there are none. InfoBarActionVerticalOrientationMargin
   0,12,0,0 is the gap above that row.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L75
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L80
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L86 */
.fui-MessageBar.fui-MessageBar:has(> .fui-MessageBar__bottomReflowSpacer) {
  padding-block-start: 0;
}

.fui-MessageBar:has(> .fui-MessageBar__bottomReflowSpacer) .fui-MessageBarBody.fui-MessageBarBody {
  padding-block-start: 14px;
}

.fui-MessageBar:has(> .fui-MessageBar__bottomReflowSpacer) .fui-MessageBarActions.fui-MessageBarActions {
  margin-block: 12px 18px;
}

.fui-MessageBar__bottomReflowSpacer.fui-MessageBar__bottomReflowSpacer {
  margin-block-end: 18px;
}
`;
