// WinUI 3 FlyoutPresenter styling for Fluent v9's PopoverSurface. Fluent paints
// the surface as a Fluent 2 Web card — control-sized corners, a transparent
// hairline, an ambient plus key drop shadow — while WinUI paints a flyout: the
// larger overlay corner, a real flyout stroke, and a fill that stops at the
// inner border edge so the translucent stroke reads at its own strength.
//
// The unit has one addressable element. `Popover` renders no DOM of its own and
// `PopoverTrigger` clones its child, so `.fui-PopoverSurface` is the whole
// surface; the arrow is rendered from `state.arrowClassName`, which is Griffel
// atoms with no stable class to name.
//
// Fluent declares no interactive state for the surface and WinUI's
// DefaultFlyoutPresenterStyle declares no VisualStateGroup, so rest is the
// entire state table.
//
// Unlike the units whose element sits inside the provider tree, this one cannot
// be scoped under `.fui-FluentProvider`: a surface without `inline` is rendered
// through `Portal`, whose mount node is appended to `document.body` and carries
// only the hashed theme class `useId('fui-FluentProvider')` produced — never the
// literal one. A descendant selector rooted at the provider therefore matches
// nothing. The surface class is doubled instead, which lifts the rule one step
// above Griffel's single-class atoms while staying independent of where the
// surface is mounted.
//
// That leaves the `--winui-*` vocabulary itself, which `winui/tokens.ts`
// declares on `.fui-FluentProvider` and which consequently does not reach the
// portal subtree either. Until the token layer is declared on a scope that
// covers portalled surfaces, the two declarations below that name a variable
// resolve nowhere; the surface then falls back to no radius and a currentColor
// hairline rather than to Fluent's paint, so this unit must not be injected
// before that scope is widened.
//
// Two WinUI rows are diagnosed and deliberately left out. FlyoutContentPadding
// is 16,15,16,17 against Fluent's flat 12/16/20px, but `size` is composed into
// hashed padding atoms and `winui/appearance.ts` puts only the appearance on the
// DOM, so no selector can address one size; restating the padding on the root
// would flatten all three.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L20
// The MinWidth/MaxWidth/MinHeight/MaxHeight setters read FlyoutThemeMinWidth and
// its three siblings, which the shipping dictionaries reference but never
// define, so the sizes they resolve to are not knowable from the theme resources
// and Fluent's unconstrained surface stands.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L30-L33
//
// Fill and foreground are also Fluent's: FlyoutPresenterBackground is
// AcrylicInAppFillColorDefaultBrush, which the token layer has no acrylic
// vocabulary for.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L5
export const popoverCss = `
/* The surface. WinUI gives a flyout the overlay corner rather than the control
   corner, and outlines it with the flyout stroke where Fluent draws a
   transparent hairline. The fill is clipped to the padding box because the
   template's Border sizes its background to the inner border edge, which keeps
   the translucent stroke from compositing over the fill beneath it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L39
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L6
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L43 */
.fui-PopoverSurface.fui-PopoverSurface {
  border-radius: var(--winui-overlay-corner-radius);
  border-color: var(--winui-surface-stroke-flyout);
  background-clip: padding-box;
}
`;
