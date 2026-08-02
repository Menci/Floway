// Toast, restyled from Fluent 2 Web onto WinUI 3. WinUI ships no toast, so the
// nearest transient surface is TeachingTip, which states its own background,
// stroke and corner on the control style rather than borrowing
// FlyoutPresenter's.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip.xaml#L5-L9
//
// The container is the focus target -- useToastContainer.js gives it
// `tabIndex: 0` -- and beyond the title's intent glyph it is the only painting
// module with a state at all; TeachingTip's own CommonStates group belongs to a
// close button Fluent's toast does not render.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L122-L163
//
// Forced colours are left to the user agent, which lands where the HighContrast
// dictionary does. The one row it cannot carry is the inner focus stroke, since
// forced colours drop box-shadow to none.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L48-L55
// https://www.w3.org/TR/css-color-adjust-1/#forced-colors-properties
//
// Fluent's action slot placement, media glyph size and subtitle 4px step are
// deliberately kept: TeachingTip's counterparts describe a button panel below
// the content, an unrendered close button, and two text rows to the toast's
// three.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L75-L77
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L96
//
// The top edge stays unpainted: TeachingTipTopHighlightBrush and the
// TopHighlight* part names are a vestige of the earlier template, which the
// WinUI 3 template no longer instantiates and the implementation never looks up.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L6
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip.h#L297-L302
export const toastCss = `
/* TeachingTipBackgroundBrush is the Tertiary step of the solid background ramp,
   which needs naming here rather than being left to the theme layer: that maps
   colorNeutralBackground1 from the Quarternary step, right for a raised card and
   wrong for this surface.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip.xaml#L5-L9
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L5
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L9

   The fill stops at the inner border edge, so the translucent stroke reads at
   its own strength rather than compositing over the fill beneath it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip.xaml#L312
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/tools/XCPTypesAutoGen/XamlOM/Model/Microsoft.UI.Xaml.Controls.cs#L2583-L2588

   TeachingTip attaches its shadow in code, so no theme resource states a value.
   Fluent gives the toast the inline elevation, which the theme layer drops as
   WinUI paints no shadow on an inline surface; this points it at the flyout
   elevation the layer left standing.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip.cpp#L2266-L2271

   Padding and foreground already agree with TeachingTipContentMargin and
   TeachingTipForegroundBrush.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L97
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L8 */
.fui-Toast.fui-Toast {
  border-radius: var(--winui-overlay-corner-radius);
  border-color: var(--winui-surface-stroke-default);
  background-color: var(--winui-solid-background-fill-tertiary);
  box-shadow: var(--shadow16);
}

/* The inverted background appearance is flattened onto the default one by our
   choice: WinUI states one look per theme dictionary rather than a darker
   variant of itself, and an inverted chip would be the only Fluent-coloured
   surface left in the control. The variant reaches the DOM only as hashed atoms,
   but each reads a theme token, so re-routing the inverted tokens flattens it
   without naming an atom, and inheritance carries the foregrounds to the title,
   media and action slots.
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
}

/* WinUI states the width as a range, not a number, and a fixed-position box is
   shrink-to-fit, so dropping Fluent's fixed 292px lets the bounds size the toast
   the way TeachingTip does.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L73-L74 */
.fui-Toaster.fui-Toaster {
  width: auto;
  min-width: 320px;
  max-width: 336px;
}

/* The XAML thickness 0,0,12,0 reads left,top,right,bottom, so it is a trailing
   gap; the logical property covers the mirrored padding Fluent emits under RTL.

   The glyph is the one slot where the inverted flattening above needs a second
   value: colorNeutralForegroundInverted2 is routed to the primary step at the
   surface because the title, body and root all read it for body text.
   Redeclaring it here, where only the glyph inherits from, lands the info intent
   on the secondary step in both appearances.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L82 */
.fui-ToastTitle__media.fui-ToastTitle__media {
  --colorNeutralForegroundInverted2: var(--colorNeutralForeground2);
  padding-inline-end: 12px;
}

/* TeachingTip sets IsTabStop to False, so a focused toast takes the common focus
   visual: a 2px outer stroke and, inset by that thickness, a 1px inner one.
   Fluent's outline in --colorStrokeFocus2 gives the outer stroke; a CSS outline
   sits outside the border box, so the pair is reproduced outside it too --
   offsetting the outline by 1px opens a band that a 1px spread shadow fills with
   the inner stroke. That shadow is outward rather than inset because the toast is
   the container's only child and covers its box. The container's radius is raised
   to the overlay corner because both rings trace the container box and would
   otherwise round tighter than the surface inside it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip.xaml#L12
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L173-L186
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L441-L452
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/DependencyObject/DependencyProperty.cpp#L22-L25
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L6 */
.fui-ToastContainer.fui-ToastContainer {
  border-radius: var(--winui-overlay-corner-radius);
}

.fui-ToastContainer.fui-ToastContainer[data-fui-focus-visible] {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
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
   resolves to TextFillColorPrimary -- the same step the body root already reads --
   so the second row loses the secondary foreground Fluent dims it with.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L11 */
.fui-ToastBody__subtitle.fui-ToastBody__subtitle {
  color: var(--colorNeutralForeground1);
}

/* TeachingTip's three button margins settle both metrics: the 12px top is common
   to all of them, and with both buttons showing the pair contributes 4px on each
   facing edge, which XAML does not collapse, so the gap is 8.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L75-L77
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip.xaml#L36-L62 */
.fui-ToastFooter.fui-ToastFooter {
  padding-top: 12px;
  gap: 8px;
}

/* The action reads as a hyperlink, which WinUI colours with the accent *text*
   ramp rather than the accent fill a button takes -- that ramp is darkened in
   light and lightened in dark so it stays legible as text.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L93
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L297 */
.fui-ToastTitle__action.fui-ToastTitle__action {
  color: var(--winui-accent-text-fill-primary);
}
`;
