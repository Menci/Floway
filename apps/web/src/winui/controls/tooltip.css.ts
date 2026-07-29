// Tooltip, restyled from Fluent 2 Web onto WinUI 3.
//
// A tooltip has no interactive states: Fluent styles only the visible/hidden
// switch, and WinUI's template carries a single OpenStates group whose two
// states are fade animations rather than appearance changes. One rule for the
// one painted state is therefore the whole file — the geometry of the content
// box, plus the flattening of Fluent's inverted appearance onto that same
// single WinUI look.
//
// Tooltip content is portalled onto the document body, so it is never a
// descendant of the provider root, the only element carrying the bare
// `fui-FluentProvider` class. The portal node instead carries the generated
// theme class `fui-FluentProviderN`, which is also the selector FluentProvider
// writes the theme's custom properties on, so an attribute-substring match on
// the shared prefix both reaches the tooltip and lands where every Fluent
// token it names resolves.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-portal/library/src/components/Portal/usePortalMountNode.ts#L248-L255
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-provider/library/src/components/FluentProvider/useFluentProviderThemeStyleTag.ts#L58-L61
//
// The WinUI vocabulary of `../tokens.ts` is declared on the provider root
// alone, so a portalled node resolves none of it. ToolTipBorderBrush is
// SurfaceStrokeColorFlyoutBrush, and the only name for that stroke is
// `--winui-surface-stroke-flyout`; pointing `--colorTransparentStroke` at a
// variable that resolves to nothing would take the border down to its initial
// style rather than recolour it, so the outline is left as Fluent draws it
// until the token layer is reachable from a portal.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L9
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L33
//
// Two pieces of Fluent's tooltip are deliberately kept. Its drop-shadow filter
// reads the shadow colour tokens rather than the `shadowN` elevations the
// theme layer flattens, and a tooltip is an overlay surface, where that layer
// leaves depth alone; the WinUI style names no shadow of its own to put in its
// place. The arrow has no WinUI counterpart at all, so its geometry stays as
// Fluent authored it, and the border it inherits follows the outline decision
// above.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L42-L75
export const tooltipCss = `
/* Geometry: WinUI lets a tooltip run 80px wider before it wraps, and its
   padding is asymmetric top to bottom. The XAML thickness reads
   left,top,right,bottom while the CSS shorthand reads top,right,bottom,left,
   so 9,6,9,8 becomes 6px 9px 8px. BackgroundSizing is InnerBorderEdge, which
   is background-clip: padding-box on the web: the fill stops at the border so
   the translucent outline reads against whatever the tooltip floats over.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L45
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L76-L77

   Appearance: WinUI states one ToolTip look, so the dark chip Fluent calls the
   inverted appearance is flattened onto the default one. That variant reaches
   the DOM only as hashed atoms, but each reads a token, so pointing the two
   static tokens at the surface and foreground the default state already
   resolves is enough for no rule to have to name an atom. ToolTipForegroundBrush
   is TextFillColorPrimaryBrush, which is what the theme layer re-points
   colorNeutralForeground1 at, and both tokens are routed through their default
   counterpart so the pair cannot drift apart. Redeclaring them on the content
   element also exposes them to caller-supplied tooltip children; that element
   is the one the inverted atoms are applied to, so it is the tightest scope
   available.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L13-L14
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToolTip_themeresources.xaml#L37-L38 */
[class*="fui-FluentProvider"] .fui-Tooltip__content {
  background-clip: padding-box;
  max-width: 320px;
  padding: 6px 9px 8px;
  --colorNeutralBackgroundStatic: var(--colorNeutralBackground1);
  --colorNeutralForegroundStaticInverted: var(--colorNeutralForeground1);
}
`;
