// Toast, restyled from Fluent 2 Web onto WinUI 3. WinUI ships no toast, so the
// nearest transient surface is TeachingTip, which states its own background,
// stroke and corner rather than borrowing FlyoutPresenter's.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip.xaml#L5-L9
//
// Forced colours are left to the user agent; the one row it cannot carry is the
// inner focus stroke, since forced colours drop box-shadow to none.
// https://www.w3.org/TR/css-color-adjust-1/#forced-colors-properties
export const toastCss = `
/* TeachingTipBackgroundBrush is the Tertiary step of the solid background ramp,
   not the Quarternary step the theme layer maps colorNeutralBackground1 from.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip.xaml#L5-L9
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L5
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L9

   TeachingTip attaches its shadow in code, so no theme resource states a value;
   the flyout elevation stands in for Fluent's inline one, which the theme layer
   drops.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip.cpp#L2266-L2271 */
.fui-Toast.fui-Toast {
  border-radius: var(--winui-overlay-corner-radius);
  border-color: var(--winui-surface-stroke-default);
  background-color: var(--winui-solid-background-fill-tertiary);
  box-shadow: var(--shadow16);
}

/* The inverted background appearance is flattened onto the default one: WinUI
   states one look per theme dictionary, and an inverted chip would be the only
   Fluent-coloured surface left in the control. The variant reaches the DOM only
   as hashed atoms, so re-routing the tokens it reads flattens it without naming
   an atom.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L5-L24
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L27-L46 */
.fui-Toast.fui-Toast {
  --colorNeutralBackgroundInverted: var(--winui-solid-background-fill-tertiary);
  --colorNeutralForegroundInverted2: var(--colorNeutralForeground1);
  --colorNeutralForegroundInverted: var(--colorNeutralForeground1);
  --colorBrandForegroundInverted: var(--colorBrandForeground1);
  --colorStatusSuccessForegroundInverted: var(--colorStatusSuccessForeground1);
  --colorStatusDangerForegroundInverted: var(--colorStatusDangerForeground1);
  --colorStatusWarningForegroundInverted: var(--colorStatusWarningForeground1);

  /* TeachingTip carries no severity, so the severity glyph is answered by the
     one control that does: InfoBar paints each severity from a SystemFillColor
     family, which the message bar in this layer already restates. Fluent's own
     status ramp is a second green, amber and red for the same three states.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L9-L11 */
  --colorStatusSuccessForeground1: var(--winui-system-fill-success);
  --colorStatusDangerForeground1: var(--winui-system-fill-critical);
  --colorStatusWarningForeground1: var(--winui-system-fill-caution);
}

/* WinUI states the width as a range, not a number, and a fixed-position box is
   shrink-to-fit, so Fluent's fixed 292px is dropped.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L73-L74 */
.fui-Toaster.fui-Toaster {
  width: auto;
  min-width: 320px;
  max-width: 336px;
}

/* The XAML thickness 0,0,12,0 reads left,top,right,bottom, so it is a trailing
   gap.

   colorNeutralForegroundInverted2 is routed to the primary step at the surface
   because the title, body and root all read it for body text; redeclaring it
   here, where only the glyph inherits from, lands the info intent on the
   secondary step in both appearances.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L82 */
.fui-ToastTitle__media.fui-ToastTitle__media {
  --colorNeutralForegroundInverted2: var(--colorNeutralForeground2);
  padding-inline-end: 12px;
}

/* WinUI's focus visual is a 2px outer stroke and, inset by that thickness, a 1px
   inner one. A CSS outline sits outside the border box, so the pair is
   reproduced outside it too: offsetting the outline by 1px opens a band that a
   1px spread shadow fills with the inner stroke. Both rings trace the container
   box, so its radius is raised to the overlay corner or they round tighter than
   the surface inside.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L173-L186
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L6 */
.fui-ToastContainer.fui-ToastContainer {
  border-radius: var(--winui-overlay-corner-radius);
}

.fui-ToastContainer.fui-ToastContainer[data-fui-focus-visible] {
  outline-offset: 1px;
  box-shadow: 0 0 0 1px var(--winui-focus-stroke-inner);
}

/* The body is TeachingTip's main content, so the step under the title is
   TeachingTipMainContentPresentMargin's top edge rather than Fluent's 6px.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L78 */
.fui-ToastBody.fui-ToastBody {
  padding-top: 12px;
}

/* Both body rows are subtitle-grade text, and TeachingTipSubtitleForegroundBrush
   resolves to TextFillColorPrimary, so the second row loses the secondary
   foreground Fluent dims it with.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L11 */
.fui-ToastBody__subtitle.fui-ToastBody__subtitle {
  color: var(--colorNeutralForeground1);
}

/* TeachingTip's three button margins share a 12px top, and with both buttons
   showing the pair contributes 4px on each facing edge, which XAML does not
   collapse, so the gap is 8.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L75-L77 */
.fui-ToastFooter.fui-ToastFooter {
  padding-top: 12px;
  gap: 8px;
}

/* The action slot takes no colour of its own. TeachingTip's ActionButton is a
   DefaultButtonStyle button, not a hyperlink, so the accent text ramp is the
   wrong reference for it -- and a declaration on the slot reached nothing
   anyway, because every element documented for it, Button and Link alike, sets
   its own colour. The child carries the WinUI colours its own control states.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip.xaml#L10
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L5 */
`;
