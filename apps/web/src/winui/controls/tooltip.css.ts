// ToolTip, restyled from Fluent 2 Web onto WinUI 3, which paints it as the
// smallest flyout there is: in-app acrylic fill, flyout stroke, and a single
// shallow shadow at half a flyout's elevation.
//
// Fluent merges the root and the content onto the same node, so
// `.fui-Tooltip__content` is the whole surface; the arrow is rendered from
// `state.arrowClassName`, Griffel atoms with no stable class to name.
//
// A tooltip is not a pointer target, so there is no hover, pressed, selected,
// disabled, focus or validity row; the one row Fluent adds and WinUI has no
// counterpart for is `appearance="inverted"`, which the surface rule flattens.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L57-L70
//
// The corner radius and the 12px content size are already true through theme.ts
// and Fluent respectively, so neither is restated.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L43-L52
//
// Line height is unsourceable, so Fluent's lineHeightBase200 of 16px stands
// rather than a number being invented: WinUI's template is a bare
// ContentPresenter and TextBlock_themeresources.xaml declares no LineHeight,
// taking the leading from the font's metrics through
// LineStackingStrategy="MaxHeight".
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L56
export const tooltipCss = `
/* Both fill and foreground are stated for every appearance -- the doubled class
   name outranks the atoms Fluent composes for its inverted surface, and pinning
   the fill alone would leave that appearance's inverted foreground standing on
   our own fill.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L43
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L44
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L46

   ToolTipBorderPadding is 9,6,9,8, read in XAML's left, top, right, bottom
   order.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L50
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L76

   ToolTipMaxWidth is 320.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L51

   The shadow's derivation is recorded at the token in ../tokens.ts. It is
   written as a filter because that is the property Fluent spends here, and a
   box-shadow would leave both painted. */
.fui-Tooltip__content.fui-Tooltip__content {
  border-color: var(--winui-surface-stroke-flyout);
  background-color: var(--winui-acrylic-in-app-fill-default);
  color: var(--winui-text-fill-primary);
  padding: 6px 9px 8px 9px;
  max-width: 320px;
  filter: drop-shadow(0 4px 9px var(--winui-tooltip-shadow-color));
}

/* Forced colours already produce ToolTip's HighContrast fill, stroke and
   foreground. Only the shadow needs an answer: a filter is not a forced-colors
   property, and WinUI casts no drop shadow while a high contrast theme is
   active.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L16-L27
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/comptree/HWCompNodeWinRT.cpp#L3962-L3970
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
@media (forced-colors: active) {
  .fui-Tooltip__content.fui-Tooltip__content {
    filter: none;
  }
}
`;
