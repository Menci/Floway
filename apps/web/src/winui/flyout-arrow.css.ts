// Every Fluent surface that grows a beak builds it from one shared helper,
// createArrowStyles, which strokes the beak's visible edges on a ::before with
// colorTransparentStroke. Stock Fluent is consistent that way -- its surfaces
// carry the same transparent stroke -- but a WinUI flyout has a visible 1px
// SurfaceStrokeColorFlyout around its whole silhouette, so a surface restyled
// here without its beak ends up outlined everywhere except where it protrudes.
//
// The beak carries no `fui-*` class, only Griffel atoms, so the border atom is
// pinned by name and the rule is written once for every arrow rather than per
// surface. Redefining colorTransparentStroke on the surface instead would hand
// a visible border to every Fluent element inside it.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L255
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/FlyoutPresenter_themeresources.xaml#L6
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ToolTip/ToolTip_themeresources.xaml#L9
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-positioning/library/src/createArrowStyles.ts#L38-L48
export const positioningArrowBorderAtom = 'f1kc0wz4';

export const flyoutArrowCss = `
.${positioningArrowBorderAtom}::before {
  border-color: var(--winui-surface-stroke-flyout);
}
`;
