// Toast, restyled from Fluent 2 Web onto WinUI 3. WinUI ships no toast, so the
// nearest transient surface is TeachingTip, and TeachingTip states its own
// background, stroke and corner on the control style rather than borrowing
// FlyoutPresenter's, so the surface here is a straight transcription of those
// three setters.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip.xaml#L5-L9
//
// Rest, focus, the intent glyph and the inverted background appearance are the
// whole state table. Eight style modules make up the control: Toast,
// ToastContainer, ToastTitle, ToastBody, ToastFooter and Toaster paint, while
// Timer carries a zero-opacity keyframe purely to time the dismissal and
// AriaLive is visually hidden, so neither of those two states anything to
// restyle. The container is the focus target — useToastContainer.js gives it
// `tabIndex: 0` and its reset class carries a `[data-fui-focus-visible]`
// outline — and beyond the title's intent glyph it is the only one of the six
// painting modules with a state at all. Its pointer handlers pause and resume
// the timer and paint nothing, which is also all TeachingTip's surface does
// under the pointer: the dictionary's own CommonStates group belongs to its
// close button, which Fluent's toast does not render.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L122-L163
//
// Forced colours are left to the user agent, and that lands where the
// HighContrast dictionary does: the surface fill resolves to Canvas and its
// stroke to CanvasText, the pair SystemColorWindow and SystemColorWindowText
// name there. The one row the user agent cannot carry is the inner focus stroke,
// because forced colours drop box-shadow to none, so the focus visual reduces to
// its outer ring.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L48-L55
// https://www.w3.org/TR/css-color-adjust-1/#forced-colors-properties
//
// Some of Fluent's rows are deliberately kept. The action slot's inline
// placement in the title's third grid column has no counterpart in TeachingTip,
// whose button metrics describe a panel below the content. The media glyph size
// likewise stands, because the only glyph size the dictionary states belongs to
// that unrendered close button. The ToastBody subtitle's own 4px step stands
// too: TeachingTip has two text rows to the toast's three, so the third row's
// spacing is Fluent's alone.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L75-L77
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L96
//
// The top edge stays unpainted because WinUI leaves it unpainted. The dictionary
// still declares TeachingTipTopHighlightBrush, its 1px height and its border
// offset, and the control header still declares TopHighlightLeft/TopHighlightRight
// part names, but the WinUI 3 template instantiates no such element and the
// implementation looks none of them up: the highlight is a vestige of the earlier
// template, not a row this layer is missing.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L6
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip.h#L297-L302
export const toastCss = `
/* The surface. TeachingTip's style names all three of the values Fluent draws
   differently: OverlayCornerRadius where Fluent takes the control corner,
   TeachingTipBorderBrush -- SurfaceStrokeColorDefault -- where Fluent draws a
   transparent hairline, and TeachingTipBackgroundBrush, the Tertiary step of the
   solid background ramp, where Fluent paints colorNeutralBackground1. That last
   one needs naming rather than leaving to the theme layer, which maps
   colorNeutralBackground1 from the Quarternary step: right for a raised card,
   wrong for this surface.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip.xaml#L5-L9
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L5
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L9

   The fill stops at the inner border edge: ContentRootGrid is a Grid, whose
   BackgroundSizing defaults to InnerBorderEdge, so the translucent stroke reads
   at its own strength rather than compositing over the fill beneath it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip.xaml#L312
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/tools/XCPTypesAutoGen/XamlOM/Model/Microsoft.UI.Xaml.Controls.cs#L2583-L2588

   Depth is moved rather than removed. TeachingTip attaches its shadow in code as
   a ThemeShadow on that same grid, so the theme resources name no value to
   transcribe, but the theme layer's split is clear: it drops elevations 2, 4 and
   8 because WinUI paints no shadow on an inline surface, and keeps 16, 28 and 64
   because an overlay does have depth. Fluent gives the toast the inline
   elevation, so this points it at the flyout one the layer left standing.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip.cpp#L2266-L2271

   Padding and foreground already agree with TeachingTipContentMargin and
   TeachingTipForegroundBrush and so carry no rule.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L97
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L8 */
.fui-Toast.fui-Toast {
  border-radius: var(--winui-overlay-corner-radius);
  border-color: var(--winui-surface-stroke-default);
  background-color: var(--winui-solid-background-fill-tertiary);
  box-shadow: var(--shadow16);
}

/* The inverted background appearance is flattened onto the default one by our
   choice. WinUI is silent about a dark toast chip -- TeachingTip states one look
   per theme dictionary, not a darker variant of itself -- and silence alone does
   not settle the question, since the same silence is what keeps Fluent's action
   slot and media glyph size above. Those two are geometry inside a surface that
   is otherwise WinUI's; the inverted chip is a whole surface, and with the
   default one now painted in the tertiary solid ramp it would be the only
   Fluent-coloured surface left in the control. The variant reaches the DOM only
   as hashed atoms, but each of them reads a theme token, so routing the inverted
   tokens to their default counterparts here flattens it without a rule having to
   name an atom, and inheritance carries the foregrounds to the title, media and
   action slots.
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

   The glyph is also the one slot where the inverted flattening above needs a
   second value. Fluent gives the info intent colorNeutralForeground2 by default
   and colorNeutralForegroundInverted2 when inverted, and that token is routed to
   the primary step at the surface because the title, body and root all read it
   for body text. Redeclaring it here, where only the glyph inherits from, lands
   the info intent on the same secondary step in both appearances.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L82 */
.fui-ToastTitle__media.fui-ToastTitle__media {
  --colorNeutralForegroundInverted2: var(--colorNeutralForeground2);
  padding-inline-end: 12px;
}

/* Focus. TeachingTip sets IsTabStop to False, so the rings a focused toast wants
   are the common focus visual rather than anything the tip states: a 2px primary
   stroke in FocusStrokeColorOuter and, inset by that same thickness, a 1px
   secondary stroke in FocusStrokeColorInner, both drawn within the focus
   rectangle -- the element's bounds less its FocusVisualMargin, which is zero by
   default. Fluent puts the tab stop on the container and rings it with a plain
   outline in --colorStrokeFocus2 at --strokeWidthThick, so retinting that token
   gives the outer stroke. A CSS outline sits outside the border box, so the pair
   is reproduced outside it as well: offsetting the outline by one pixel opens a
   band that a 1px spread shadow fills with the inner stroke, which keeps the two
   concentric and in WinUI's order while leaving the toast's own surface stroke
   where it is. That shadow is drawn outward rather than inset because the toast
   is the container's only child and covers its box, so an inset ring would be
   painted over. The container's radius is raised to the overlay corner as well,
   because both rings trace the container box and would otherwise round tighter
   than the surface inside it.
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

/* The footer is TeachingTip's button panel, and the three button margins settle
   both of its metrics. The 12px top is common to all of them, and the states
   that apply them are mutually exclusive -- the panel margin goes on whichever
   single button is visible, the left/right pair on the two together -- so the
   step under the content is 12 rather than Fluent's 16. With both buttons
   showing, the pair contributes 4px on each facing edge, and XAML margins do not
   collapse, so the gap between them is 8 rather than Fluent's 14.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip_themeresources.xaml#L75-L77
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/TeachingTip/TeachingTip.xaml#L36-L62 */
.fui-ToastFooter.fui-ToastFooter {
  padding-top: 12px;
  gap: 8px;
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
