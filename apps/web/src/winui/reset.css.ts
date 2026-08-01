// Where a fill stops.
//
// This is the one place the layer corrects a difference between the two box
// models rather than between the two design languages. A XAML element paints
// its Background to the inner edge of its BorderThickness -- BackgroundSizing
// defaults to InnerBorderEdge -- while CSS paints it under the border as well.
// Every stroke in this vocabulary is a translucent white or black over a
// translucent fill, so left at the CSS default the two compose and every
// outlined control reads heavier than WinUI's -- measured on a dark dropdown,
// rgb(76, 76, 76) where the same brush over the surface alone gives
// rgb(65, 65, 65). Clipping to the padding box brings it to rgb(64, 64, 64).
// https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.xaml.controls.control.backgroundsizing
// https://learn.microsoft.com/en-us/windows/windows-app-sdk/api/winrt/microsoft.ui.xaml.controls.backgroundsizing
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L199
//
// It is stated once, for everything, rather than per control. The difference
// belongs to the mapping and not to any one component, and a list of the
// controls that happen to pair a fill with a stroke today would silently miss
// the next one. Where an element has no border the two boxes coincide and the
// declaration does nothing, which is most of the document.
//
// It takes no theme branch and no state branch, because BackgroundSizing is
// geometry and not a brush: no theme dictionary keys it, so the Default and
// Light dictionaries cannot disagree about it, and across the shipping style
// dictionaries the only templates that move it between visual states are the
// toggle buttons, whose checked states swap to OuterBorderEdge. That swap
// belongs to those controls and is restated in controls/button.css.ts, as the
// accent button's unconditional OuterBorderEdge is. Forced colours want the
// same geometry: the border box then carries the forced border colour, which
// is the band a high contrast theme draws a control's edge with.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ToggleButton_themeresources.xaml#L255-L256
//
// It is the floor of the cascade rather than a claim on any element. The
// opt-out sits inside :where(), so each row weighs no more than the universal
// selector or the pseudo-element it names, and anything that states a
// background-clip of its own wins against it whatever order the sheets are
// injected in -- this layer's own OuterBorderEdge restatements, and equally
// the Fluent components that inset a background for a reason of their own, the
// presence badge holding its fill clear of an antialiased glyph edge and the
// positioning arrow clipping to its content box.
//
// It still stops at the opt-out. A surface designed against Fluent's own
// rendering was drawn with the fill running under its border, and this is a
// change to how that surface paints even though it is not a change of palette.
import { notOptedOut } from './tokens';

export const winuiResetCss = `
*:where(${notOptedOut}),
*:where(${notOptedOut})::before,
*:where(${notOptedOut})::after {
  background-clip: padding-box;
}
`;
