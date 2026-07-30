// Toast, restyled from Fluent 2 Web onto WinUI 3. WinUI ships no toast, so the
// nearest transient surface is TeachingTip; a toast is flyout-grade, so the
// surface itself takes the same reading of FlyoutPresenter that popover.css.ts
// took — the overlay corner, the flyout stroke, and a fill clipped to the inner
// border edge — rather than a third reading of the same two dictionaries.
//
// Rest, focus and the inverted background appearance are the whole state table.
// Eight style modules make up the control: Toast, ToastContainer, ToastTitle,
// ToastBody, ToastFooter and Toaster paint, while Timer carries a zero-opacity
// keyframe purely to time the dismissal and AriaLive is visually hidden, so
// neither of those two states anything to restyle. The container is the focus
// target — useToastContainer.js gives it `tabIndex: 0` and its reset class
// carries a `[data-fui-focus-visible]` outline — and it is the only one of the
// six painting modules with a state beyond rest and inverted. The TeachingTip
// dictionary's own CommonStates group belongs to its close button, which
// Fluent's toast does not render.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L122-L163
//
// Some of Fluent's rows are deliberately kept. The action slot's inline
// placement in the title's third grid column has no counterpart in TeachingTip,
// whose button metrics describe a panel below the content. The media glyph size
// likewise stands, because the only glyph size the dictionary states belongs to
// that unrendered close button. The ToastBody subtitle's own 4px step stands
// too: TeachingTip has two text rows to the toast's three, so the third row's
// spacing is Fluent's alone.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L76-L77
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L96
//
// One row is missing rather than kept. TeachingTipTopHighlightBrush paints a 1px
// highlight along the top edge, and it is strongly theme-dependent — a faint
// #0DFFFFFF in dark against a near-opaque #99FFFFFF in light — so it cannot be
// approximated from any neighbouring stroke. tokens.ts declares no variable for
// it, and this layer does not mint values locally, so the edge stays unpainted
// until one exists.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L6
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L28
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L98
export const toastCss = `
/* The surface. A toast floats, so it takes the overlay corner and the flyout
   stroke where Fluent draws the control corner and a transparent hairline, and
   the fill stops at the inner border edge so the translucent stroke reads at its
   own strength rather than compositing over the fill beneath it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L39
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L6
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L43

   Depth is moved rather than removed. TeachingTip carries its shadow as a
   ThemeShadow in the control template, so the theme resources name no value to
   transcribe, but the theme layer's split is clear: it drops elevations 2, 4 and
   8 because WinUI paints no shadow on an inline surface, and keeps 16, 28 and 64
   because an overlay does have depth. Fluent gives the toast the inline
   elevation, so this points it at the flyout one the layer left standing.

   The fill is TeachingTipBackgroundBrush, the Tertiary step of the solid
   background ramp. It needs saying here because Fluent paints the toast in
   colorNeutralBackground1, which the theme layer maps from the Quarternary step
   — that mapping is right for a raised card and wrong for this surface, so the
   two diverge and the rule names the tertiary fill directly.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L9

   Padding and foreground already agree with TeachingTipContentMargin and
   TeachingTipForegroundBrush and so carry no rule.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L97
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L8 */
.fui-Toast.fui-Toast {
  border-radius: var(--winui-overlay-corner-radius);
  border-color: var(--winui-surface-stroke-flyout);
  background-color: var(--winui-solid-background-fill-tertiary);
  background-clip: padding-box;
  box-shadow: var(--shadow16);
}

/* The inverted background appearance is flattened onto the default one. WinUI
   states a single TeachingTip look — the two dictionaries differ from each other,
   not from a darker variant of themselves — so the dark chip Fluent offers as a
   second appearance has nothing to correspond to. The variant reaches the DOM
   only as hashed atoms, but each of them reads a theme token, so routing the
   inverted tokens to their default counterparts here flattens it without a rule
   having to name an atom, and inheritance carries the foregrounds to the title,
   media and action slots. The inverted fill is routed to the tertiary solid
   background rather than to colorNeutralBackground1, for the reason the surface
   rule above gives.
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

/* Every toast fills the strip, so the strip carries the toast's width. WinUI
   states that width as a range, not a number, and a fixed-position box is
   shrink-to-fit, so dropping Fluent's fixed 292px lets the bounds do the sizing
   the way TeachingTip does: content-sized between 320 and 336.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L73-L74 */
.fui-Toaster.fui-Toaster {
  width: auto;
  min-width: 320px;
  max-width: 336px;
}

/* The gap between the intent icon and the title. The XAML thickness reads
   left,top,right,bottom, so 0,0,12,0 is a trailing gap; expressing it as a
   logical property covers the mirrored padding Fluent emits under RTL.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L82 */
.fui-ToastTitle__media.fui-ToastTitle__media {
  padding-inline-end: 12px;
}

/* Focus. The container is the tab stop, and Fluent rings it with a plain
   outline in --colorStrokeFocus2 at --strokeWidthThick, so retinting that token
   gives the outer ring WinUI's colour at the 2px WinUI also asks for. WinUI's
   visual is two concentric rings, and the inner one is the control's own 1px
   edge, which here is the toast's border, so the surface stroke gives way to
   the inner focus stroke while the ring shows. The container's radius is raised
   to the overlay corner as well, because the outline traces the container box
   and would otherwise round tighter than the surface inside it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L250-L252
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L6 */
.fui-ToastContainer.fui-ToastContainer {
  border-radius: var(--winui-overlay-corner-radius);
}

.fui-ToastContainer.fui-ToastContainer[data-fui-focus-visible] {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
}

.fui-ToastContainer[data-fui-focus-visible] .fui-Toast.fui-Toast {
  border-color: var(--winui-focus-stroke-inner);
}

/* The body is TeachingTip's main content, so the step under the title is
   TeachingTipMainContentPresentMargin's top edge rather than Fluent's 6px.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L78 */
.fui-ToastBody.fui-ToastBody {
  padding-top: 12px;
}

/* Both body rows are subtitle-grade text, and TeachingTipSubtitleForegroundBrush
   resolves to TextFillColorPrimary — the same step the body root already reads —
   so the second row loses the secondary foreground Fluent dims it with.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L11 */
.fui-ToastBody__subtitle.fui-ToastBody__subtitle {
  color: var(--colorNeutralForeground1);
}

/* The footer is TeachingTip's button panel. The gap between its buttons is the
   4px inner edge of TeachingTipRightButtonMargin, in place of Fluent's 14px.
   The panel's vertical step keeps Fluent's value: the dictionary states a 12px
   top on the panel and another on each button, and the theme resources alone do
   not settle whether the two stack, so there is no single figure to transcribe.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L75-L77 */
.fui-ToastFooter.fui-ToastFooter {
  gap: 4px;
}

/* The action beside the title reads as a hyperlink, and WinUI colours one with
   the accent text ramp's primary step rather than with the accent fill a button
   takes -- the ramp is darkened in light and lightened in dark precisely so it
   stays legible as text.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L93
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L297 */
.fui-ToastTitle__action.fui-ToastTitle__action {
  color: var(--winui-accent-text-fill-primary);
}
`;
