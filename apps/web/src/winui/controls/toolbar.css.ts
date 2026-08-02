// Toolbar and ToolbarButton, restyled from Fluent 2 Web onto WinUI 3.
//
// ToolbarButton owns no chrome of its own: it merges a flex direction and an
// icon size for the vertical layout and hands everything else to the Button
// styles, so its rest, hover, pressed, disabled, focus and checked looks are
// already WinUI's through `button.css.ts`, at the subtle appearance that
// `winui/appearance.ts` stamps on it — SubtleButtonStyle, the fill a command
// bar item is meant to have.
//
// That delegation is what WinUI asks for rather than a gap in this file.
// AppBarButton, the control a WinUI command bar hosts, resolves its own state
// table onto the brushes SubtleButtonStyle already spends: a transparent rest
// fill, SubtleFillColorSecondary under the pointer, SubtleFillColorTertiary
// under a press, SubtleFillColorDisabled — the same #00FFFFFF as the
// transparent one — while disabled, TextFillColorPrimary for the label through
// rest and hover, TextFillColorSecondary under a press and TextFillColorDisabled
// while disabled. Its Default dictionary, which is the dark one, and its Light
// dictionary name that list key for key, so neither scheme asks for a value
// here; its HighContrast dictionary hands the same slots to the system brushes,
// which is what Fluent's own forced-colours atoms do, so that mode is left to
// them deliberately.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/AppBarButton_themeresources.xaml#L4-L38
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/AppBarButton_themeresources.xaml#L74-L108
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L25-L28
//
// The checked state of a ToolbarToggleButton is the one look the toolbar
// package paints in its own right, and it paints it out of
// colorSubtleBackgroundSelected, colorNeutralForeground2Selected and
// colorNeutralForeground2BrandSelected — all three of which `button.css.ts`
// re-points onto the accent fill and the on-accent label, with hover, pressed
// and disabled continuing that ramp. AppBarToggleButton states exactly that
// quartet, AccentFillColorDefault through Secondary, Tertiary and Disabled, so
// the toolbar's own slot for the fact and the toggle button's slot for it end
// at the same place.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/AppBarToggleButton_themeresources.xaml#L9-L12
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/AppBarToggleButton_themeresources.xaml#L22-L25
//
// The container keeps Fluent's layout, which is a departure nothing sources.
// WinUI's CommandBar is a full-width bar of 68-wide items stacking a glyph
// over a label at a 40px AppBarThemeCompactHeight row, with everything past
// the fold moving into an overflow flyout; the dashboard's toolbars are short
// inline groups beside a heading, and Fluent's Toolbar is a flex row of
// ordinary buttons. Where the restyle stops -- at the typography the bar
// shares with its items, short of the bar's own geometry -- is our line, not
// one WinUI draws.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L19126-L19134
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L26
import { notOptedOut } from '../tokens';

export const toolbarCss = `
/* A command bar item's label runs at 12, two steps below the 14 Fluent's button
   reset uses. AppBarButton states the size on its own TextLabel, and
   SplitButtonCommandBarStyle -- which exists so a SplitButton dropped into a
   CommandBar matches the AppBarButtons beside it -- repeats it as a Setter. No
   visual state in either control touches FontSize, so the one value covers
   every state and both schemes. The icon is unaffected, since Fluent sizes the
   icon slot in its own right rather than by inheritance.
   ToolbarButton contributes no class of its own, so the subject is the button
   root and the toolbar is the context that scopes it. That the selector also
   catches a plain Button, a MenuButton trigger or either half of a SplitButton
   placed in a toolbar is the intent rather than overreach -- WinUI states this
   typography for a SplitButton because of where it is hosted, so every item of
   the bar carries it, whichever control provides it -- and so is its reaching a
   toolbar at any Fluent size, since WinUI states one command bar typography
   rather than a scale.
   The line box stays Fluent's 20px. Neither control states a LineHeight, and
   since Fluent's medium button takes its height from line box plus padding plus
   stroke, pairing the 16px step that its own 12px size uses would take the item
   from 32px to 28 -- further from the 40px row a command bar gives its items
   than Fluent's 32 already is.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L19402-L19406
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitButton/SplitButton_themeresources.xaml#L104-L119
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/SplitButton/SplitButton_themeresources.xaml#L113 */
.fui-Toolbar .fui-Button.fui-Button${notOptedOut} {
  font-size: var(--fontSizeBase200);
}
`;
