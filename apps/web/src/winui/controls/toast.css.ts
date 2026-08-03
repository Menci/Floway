// Toast, restyled from Fluent 2 Web onto WinUI 3's InfoBar. WinUI ships no
// toast, and InfoBar is its one control that carries a severity, so the card is
// an InfoBar that floats: the same tint, stroke, corner, metrics and typography,
// over the flyout elevation an inline InfoBar has no need of.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar.xaml#L3-L15
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L3-L61
//
// Fluent settles the intent in a context that reaches no slot a selector can
// name, and injects a glyph of its own for it -- a diamond for `error` and a
// triangle for `warning`, where every InfoBar severity is a circle. Both are
// answered at the runtime chokepoint in ../appearance.ts, which stamps
// `data-winui-intent` on the card and fills the media slot from the same map
// the message bar reads.
//
// Forced colours are left to the user agent except where ./severity.ts
// states otherwise; the one row neither can carry is the inner focus stroke,
// since forced colours drop box-shadow to none.
// https://www.w3.org/TR/css-color-adjust-1/#forced-colors-properties
import { severityCss } from './severity';

export const toastCss = `
/* InfoBarMinHeight, and the border thickness 1 over InfoBarBorderBrush, which is
   the card stroke family rather than the transparent stroke Fluent leaves the
   card with.

   InfoBarContentRootPadding is the thickness 16,0,0,0, so leading only; the
   trailing 16 is InfoBarPanelMargin's, which in an InfoBar separates the text
   panel from the close button column and here, with no close button in the
   template, is what holds the content off the trailing edge.

   Both corners are already ControlCornerRadius: InfoBar states it, and Fluent
   reaches for borderRadiusMedium, which the theme layer maps onto the same
   token -- so the card and the container that clips it are left alone.

   InfoBar is an inline surface and draws no shadow. A toast is not inline, so
   it keeps an elevation, and the flyout depth is the one WinUI gives a surface
   that floats over the page it belongs to.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L66
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L20-L21
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L75
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L78
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar.xaml#L11
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L5 */
.fui-Toast.fui-Toast {
  min-height: 48px;
  padding: 0 16px;
  border-color: var(--winui-card-stroke-default);
  box-shadow: var(--shadow16);
}

${severityCss({ card: '.fui-Toast', icon: '.fui-ToastTitle__media' })}

/* Fluent's inverted appearance is flattened onto the default one: WinUI states
   one look per theme dictionary, and an inverted chip would be the only
   Fluent-coloured surface left in the control. The variant reaches the DOM only
   as hashed atoms, so nothing can name it -- but every one of them is a colour,
   and each is answered by the InfoBar colour that belongs in its place. The
   severity fills above outrank the inverted background, and the row below
   outranks the inverted foregrounds the card and its footer inherit.

   InfoBarTitleForeground and InfoBarMessageForeground are both
   TextFillColorPrimary, so the two rows differ in weight alone and neither
   takes the secondary step Fluent dims its second row with.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L17-L18 */
.fui-Toast.fui-Toast,
.fui-ToastTitle.fui-ToastTitle,
.fui-ToastBody.fui-ToastBody,
.fui-ToastBody__subtitle.fui-ToastBody__subtitle {
  color: var(--winui-text-fill-primary);
}

/* The title row's own step in both orientations: InfoBarTitleHorizontalOrientationMargin
   and InfoBarPanelVerticalOrientationPadding lead with the same 14, which the
   panel spends on its first child either way.

   A title-only card is InfoBar's horizontal orientation, whose panel padding is
   zero on every side: 14 + the 20px line + InfoBarMinHeight's remaining 14 is
   the whole box. A card with a body below it is the vertical orientation, and
   the trailing 18 of that padding closes it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L79-L82 */
.fui-ToastTitle.fui-ToastTitle {
  padding-top: 14px;
}

.fui-Toast.fui-Toast:has(.fui-ToastBody, .fui-ToastFooter) {
  padding-bottom: 18px;
}

/* InfoBarMessageVerticalOrientationMargin's leading 4. The horizontal term of
   that thickness, the 12 that opens a gap when title and message share a line,
   is not spent: Fluent gives the body a grid row of its own, so the two rows
   never share one.

   InfoBarMessageFontSize and InfoBarTitleFontSize are both 14, and the subtitle
   is a second message row rather than a caption, so it drops the smaller step
   Fluent gives it and takes the message row's own.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L84
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L62-L65 */
.fui-ToastBody.fui-ToastBody {
  padding-top: 4px;
}

.fui-ToastBody__subtitle.fui-ToastBody__subtitle {
  font-size: var(--fontSizeBase300);
  line-height: var(--lineHeightBase300);
}

/* InfoBarActionVerticalOrientationMargin, the thickness 0,12,0,0, is the step
   above the action row. Nothing upstream rules the gap between several actions,
   since an InfoBar carries one, so Fluent's own spacing stands.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L86 */
.fui-ToastFooter.fui-ToastFooter {
  padding-top: 12px;
}

/* InfoBarActionHorizontalOrientationMargin, the thickness 16,8,0,0. The 8 is
   what leaves a 32px button centred in InfoBarMinHeight, and the 16 is the gap
   from the text panel it trails.

   The slot takes no colour of its own. InfoBar's ActionButton is a
   DefaultButtonStyle button, not a hyperlink, so the accent text ramp is the
   wrong reference for it -- and a declaration on the slot reached nothing
   anyway, because every element documented for it, Button and Link alike, sets
   its own colour.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L85
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar.xaml#L115
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L5 */
.fui-ToastTitle__action.fui-ToastTitle__action {
  padding-top: 8px;
  padding-inline-start: 16px;
}

/* WinUI states the width of a transient surface as a range, not a number, and a
   fixed-position box is shrink-to-fit, so Fluent's fixed 292px is dropped. */
.fui-Toaster.fui-Toaster {
  width: auto;
  min-width: 320px;
  max-width: 336px;
}

/* WinUI's focus visual is a 2px outer stroke and, inset by that thickness, a 1px
   inner one. A CSS outline sits outside the border box, so the pair is
   reproduced outside it too: offsetting the outline by 1px opens a band that a
   1px spread shadow fills with the inner stroke.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L173-L186 */
.fui-ToastContainer.fui-ToastContainer[data-fui-focus-visible] {
  outline-offset: 1px;
  box-shadow: 0 0 0 1px var(--winui-focus-stroke-inner);
}
`;
