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
import { severityCss } from './severity';

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
  border-color: var(--winui-card-stroke-default);
  /* Without this, the grid item's automatic minimum size is the whole message
     on one line: the bar overflows its track, widens everything beside it, and
     Fluent's auto layout never observes a width small enough to reflow. */
  min-width: 0;
}

/* Fluent tints the brand ramp for its intents and strokes the bar to match; the
   InfoBar idiom replaces both, and the stroke stays the card stroke all four
   severities share. */
${severityCss({ card: '.fui-MessageBar', icon: '.fui-MessageBar__icon' })}

/* InfoBarPanelMargin, the thickness 0,0,16,0.

   The wrap is a departure: WinUI wraps both TextBlocks WrapWholeWords, which
   never splits a word, so a token longer than the line overflows the panel.
   These bars carry a server's own words -- URLs, ids, response bodies with no
   space in them -- and the panel is a grid item, so that overflow both hides
   the text and widens the track it sits in. 'anywhere' rather than
   'break-word': only 'anywhere' lowers the min-content contribution, which is
   what stops the widening.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L78
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar.xaml#L114
   https://drafts.csswg.org/css-text-4/#overflow-wrap-property */
.fui-MessageBarBody.fui-MessageBarBody {
  padding-inline-end: 16px;
  min-width: 0;
  overflow-wrap: anywhere;
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
`;
