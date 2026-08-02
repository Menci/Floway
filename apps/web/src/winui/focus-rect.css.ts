// XAML draws one focus visual for every focusable element: a primary
// FocusStrokeColorOuter band with FocusStrokeColorInner riding its inner edge,
// which is why the outline carries the outer colour and the last pixel of the
// inset shadow's depth carries the inner one.
//
// Both strokes are drawn inside the element's own box. Everything that wears
// this sits in a host that clips what leaves it -- a table cell, a card, a
// scrollport -- so an outward rect would be cut on at least one side, and the
// pair has to seat itself within the box it belongs to.
//
// The -within form is for a host whose focusable element the app does not
// render: a scroller the engine makes focusable because it overflows and holds
// nothing that can take focus itself.
//
// Under forced colours the user agent drops the inset shadow and forces the
// outline onto CanvasText, so no branch is needed there.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
// https://github.com/microsoft/microsoft-ui-xaml/blob/543310634592831f8f2638301ece05d2d2dbea39/src/dxaml/xcp/components/FocusRect/FocusRectManager.cpp#L173-L174
// https://drafts.csswg.org/css-color-adjust/#forced-colors-properties

// The pair of strokes, for a control whose selector cannot be a class because
// the app does not render the element that takes focus.
export const focusRectStrokes = `
  box-shadow: inset 0 0 0 var(--winui-focus-visual-depth) var(--winui-focus-stroke-inner);
  outline: var(--winui-focus-visual-primary-thickness) solid var(--winui-focus-stroke-outer);
  outline-offset: calc(-1 * var(--winui-focus-visual-primary-thickness));
`;

export const focusRectCss = `
.winui-focus-rect:focus-visible,
.winui-focus-rect-within :focus-visible {${focusRectStrokes}}
`;
