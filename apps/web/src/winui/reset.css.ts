// Where a fill stops.
//
// This is the one place the layer corrects a difference between the two box
// models rather than between the two design languages. A XAML `Border` paints
// its `Background` inside the `BorderThickness`; CSS paints it under the border
// as well. Every stroke in this vocabulary is a translucent white or black over
// a translucent fill, so left at the CSS default the two compose and every
// outlined control reads heavier than WinUI's -- measured on a dark dropdown,
// rgb(76, 76, 76) where the same brush over the surface alone gives
// rgb(65, 65, 65). Clipping to the padding box brings it to rgb(64, 64, 64).
//
// It is stated once, for everything, rather than per control. The difference
// belongs to the mapping and not to any one component, and a list of the
// controls that happen to pair a fill with a stroke today would silently miss
// the next one. Where an element has no border the two boxes coincide and the
// declaration does nothing, which is most of the document.
//
// It still stops at the opt-out. A surface designed against Fluent's own
// rendering was drawn with the fill running under its border, and this is a
// change to how that surface paints even though it is not a change of palette.
// https://learn.microsoft.com/en-us/dotnet/api/system.windows.controls.border.background
import { notOptedOut } from './tokens';

export const winuiResetCss = `
*${notOptedOut},
*${notOptedOut}::before,
*${notOptedOut}::after {
  background-clip: padding-box;
}
`;
