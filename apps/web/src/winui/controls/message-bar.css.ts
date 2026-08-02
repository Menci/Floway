// MessageBar, restyled from Fluent 2 Web onto WinUI 3's InfoBar. An InfoBar has
// no hover, pressed, disabled or focus appearance, so every rule below is a rest
// rule; only the theme varies.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar.xaml#L16-L92
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L3-L61
//
// InfoBarCloseButtonStyle rebrushes the Button brushes onto the AppBarButton
// chromeless map, which Fluent's transparent appearance already carries once
// controls/button.css.ts has restated it, so this file only sizes the button.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/AppBarButton_themeresources.xaml#L5-L16
//
// Fluent merges the multiline layout and the resolved intent in JavaScript,
// writing nothing a selector could name. The multiline layout is reached
// structurally, through the `bottomReflowSpacer` slot Fluent renders only there;
// the four severities are reached through `data-winui-intent`, which the runtime
// chokepoint stamps — the same chokepoint that swaps in the filled glyph.
export const messageBarCss = `
/* InfoBarMinHeight, and InfoBarContentRootPadding — the thickness 16,0,0,0, so
   leading only. The stroke is restated because InfoBar takes InfoBarBorderBrush
   from the card stroke family where Fluent's border reads the neutral control
   stroke; the two agree in light (#0000000f) but not in dark (#00000019 against
   #ffffff12).
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L66
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L75
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L20 */
.fui-MessageBar.fui-MessageBar {
  min-height: 48px;
  padding-inline-start: 16px;
  border-color: var(--winui-card-stroke, var(--colorNeutralStroke1));
  /* Without this, the grid item's automatic minimum size is the whole message
     on one line: the bar overflows its track, widens everything beside it, and
     Fluent's auto layout never observes a width small enough to reflow. */
  min-width: 0;
}

/* InfoBarIconMargin, the thickness 0,16,14,16, whose block terms pin the glyph
   to the first line of the message rather than to the middle of the bar — hence
   align-self. 16 + 16 + 16 is InfoBarMinHeight, so the two placements differ
   exactly when the body wraps, the case the margin exists for.

   WinUI stacks a severity-coloured disc under a symbol painted in
   TextFillColorInverse; a Fluent *Filled circle glyph is that silhouette
   inverted, one path with the symbol as negative space, so the disc behind it
   carries the inverse layer. All four are an r=8 circle in a 20 unit box — 80%
   of the closest side on a square 1em icon, with the stops just inside that
   edge so no ring escapes from under the glyph.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar.xaml#L107-L109
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

/* Each severity maps onto one SystemFillColor family: the bar takes its
   Background step, the glyph the plain one. Fluent instead tints the brand ramp
   and strokes the bar to match; the stroke stays the card stroke all four
   share.
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

/* InfoBarPanelMargin, the thickness 0,0,16,0.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L78 */
.fui-MessageBarBody.fui-MessageBarBody {
  padding-inline-end: 16px;
}

/* The leading 12px of InfoBarMessageHorizontalOrientationMargin replaces the
   literal space Fluent emits from the ::after below — the two go together, or
   the margin lands on top of a gap that is still there. The shared 14px top
   term of that thickness and of InfoBarTitleHorizontalOrientationMargin is not
   spent: we keep Fluent's centring, which agrees with WinUI's top-alignment to
   within a pixel on a 48px single-line bar, and the wrapping case is the
   multiline layout with its own term below.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L81
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L83 */
.fui-MessageBarTitle.fui-MessageBarTitle {
  margin-inline-end: 12px;
}

.fui-MessageBarTitle.fui-MessageBarTitle::after {
  content: none;
}

/* InfoBarCloseButtonStyle's uniform 5px margin, transcribed as padding on the
   slot rather than on the button, where it would sit outside the grid area and
   stop contributing the 5 + 38 + 5 that gives the bar its height.
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

/* Vertical orientation. Fluent's 10px of multiline root padding offsets every
   child; WinUI offsets the text panel alone, so the root term is zeroed and the
   panel carries its own block padding — otherwise the glyph and the close
   button sit 26 and 15 down instead of 16 and 5.

   InfoBarPanelVerticalOrientationPadding is 0,14,0,18, and Fluent lifts the
   action buttons into a grid row of their own, so the trailing 18 goes on that
   row instead of on the body. The actions row and the reflow spacer share one
   cell and both carry it, which keeps 18px below the last content whether or
   not there are actions, since Fluent hides the row outright when there are
   none. InfoBarActionVerticalOrientationMargin 0,12,0,0 is the gap above it.
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

/* A body of several messages is the same vertical orientation reached by another
   route, so it takes the same InfoBarPanelVerticalOrientationPadding terms. The
   gap is the leading 4 of InfoBarMessageVerticalOrientationMargin, which
   ArrangeOverride adds between children and not before the first, so a bar of one
   message is untouched. Wrapping is restored because the root's nowrap belongs to
   the horizontal orientation this content is no longer in.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L80
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L84 */
.fui-MessageBar:has([data-winui-message-lines]) .fui-MessageBarBody.fui-MessageBarBody {
  padding-block: 14px 18px;
}

[data-winui-message-lines] {
  display: grid;
  gap: 4px;
  white-space: normal;
}

/* Forced colours. WinUI's HighContrast dictionary drops the severity fill and
   doubles the stroke; the user agent's forced adjustment already lands the
   colours, leaving only the thickness to state. It cannot reach the badge:
   background-image is not among the forced properties, so the gradient carrying
   HighlightText would go on painting the inverse text fill of the underlying
   scheme. Opting the badge out is what lets both layers be named. A media query
   adds no specificity, so the selector matches the severity rules it overrides.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L42-L60
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
@media (forced-colors: active) {
  .fui-MessageBar.fui-MessageBar {
    border-width: 2px;
  }

  .fui-MessageBar[data-winui-intent] .fui-MessageBar__icon.fui-MessageBar__icon {
    forced-color-adjust: none;
    color: Highlight;
    background: radial-gradient(
      closest-side,
      HighlightText 79%,
      transparent 80%
    );
  }
}
`;
