// ToolTip, restyled from Fluent 2 Web onto WinUI 3. Fluent paints a tooltip as
// a Fluent 2 Web card — the neutral surface, a transparent hairline, a two-layer
// ambient-plus-key drop shadow, and its own padding — while WinUI paints it as
// the smallest flyout there is: the in-app acrylic fill, the flyout stroke, and
// a single shallow shadow at half a flyout's elevation.
//
// The unit has one addressable element. Fluent merges the root and the content
// onto the same node, so `.fui-Tooltip__content` is the whole surface; the arrow
// is rendered from `state.arrowClassName`, which is Griffel atoms with no stable
// class to name, exactly as popover.css.ts documents.
//
// A tooltip is not a pointer target, so it has no hover, pressed, selected,
// checked, disabled, focus, read-only or validity row: WinUI's template carries
// a single VisualStateGroup whose two states fade the presenter in and out
// rather than repaint it. The state table is therefore the theme rows — light
// and dark, which the `--winui-*` values below carry per scheme, and high
// contrast, which is restated at the end of this sheet — plus one row Fluent
// adds and WinUI has no counterpart for, `appearance="inverted"`, which the
// surface rule flattens.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L57-L70
//
// Two of WinUI's rows are already true and are not restated. The corner is
// ControlCornerRadius rather than the overlay radius, and theme.ts already
// points borderRadiusMedium at it; and the content font size is 12, which
// Fluent already sets. BackgroundSizing is InnerBorderEdge, which reset.css.ts
// already applies to everything.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L43-L52
//
// One row is unsourceable and Fluent's stands. The template is a bare
// ContentPresenter with no Style and no TextBlockStyle, so no line height is
// declared for it; TextBlock_themeresources.xaml declares no LineHeight at all,
// because WinUI takes the leading from the font's own metrics through
// LineStackingStrategy="MaxHeight". Fluent's lineHeightBase200 of 16px is left
// alone rather than a number being invented to sit under the sourced 12.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L56
export const tooltipCss = `
/* The surface. A tooltip is a flyout, so it takes the in-app acrylic fill as
   the flat colour that brush declares for itself where there is no backdrop to
   tint, and the flyout stroke where Fluent draws a transparent hairline. WinUI
   gives the tooltip one fill and one foreground, so both are stated for every
   appearance -- the doubled class name outranks the atoms Fluent composes for
   its inverted surface, and pinning the fill alone would leave that
   appearance's inverted foreground standing on our own fill.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L43
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L44
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L46

   ToolTipBorderPadding is 9,6,9,8, read in XAML's left, top, right, bottom
   order, against Fluent's 4,11,6,11 -- wider than WinUI's on the sides and
   shorter above and below.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L50
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L76

   ToolTipMaxWidth is 320 where Fluent wraps at 240.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L51

   The shadow replaces Fluent's ambient-plus-key pair with the single
   directional one WinUI's recipe yields for this elevation; its derivation and
   the one assumption it carries are recorded at the token in ../tokens.ts. It
   is written as a filter because that is the property Fluent spends here, and
   a box-shadow would leave both painted. */
.fui-Tooltip__content.fui-Tooltip__content {
  border-color: var(--winui-surface-stroke-flyout);
  background-color: var(--winui-acrylic-in-app-fill-default);
  color: var(--winui-text-fill-primary);
  padding: 6px 9px 8px 9px;
  max-width: 320px;
  filter: drop-shadow(0 4px 9px var(--winui-tooltip-shadow-color));
}

/* High contrast. ToolTip's HighContrast dictionary names the system window and
   window-text brushes for the fill, the stroke and the foreground and keeps the
   1px border, which is what forced colours already make of the declarations
   above. Only the shadow needs an answer: a filter is not a forced-colors
   property, and WinUI casts no drop shadow at all while a high contrast theme
   is active.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L16-L27
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/comptree/HWCompNodeWinRT.cpp#L3962-L3970
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
@media (forced-colors: active) {
  .fui-Tooltip__content.fui-Tooltip__content {
    filter: none;
  }
}
`;
