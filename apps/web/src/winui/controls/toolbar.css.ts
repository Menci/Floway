// Toolbar and ToolbarButton, restyled from Fluent 2 Web onto WinUI 3.
//
// ToolbarButton owns no chrome of its own: it merges a flex direction and an
// icon size for the vertical layout and hands everything else to the Button
// styles, so its rest, hover, pressed, disabled, focus and checked looks are
// already WinUI's through `button.css.ts`, at the subtle appearance that
// `winui/appearance.ts` stamps on it — SubtleButtonStyle, the fill a command
// bar item is meant to have. Nothing about those states belongs here.
//
// WinUI's CommandBar is not part of the theme resource corpus. Its one
// statement about a control hosted in a command bar is
// SplitButtonCommandBarStyle, which exists so a SplitButton dropped into a
// CommandBar matches the AppBarButtons beside it and therefore names the
// typography those items share. Its remaining metrics are either split-button
// geometry or keys the corpus does not define, so this file carries the
// typography alone and the toolbar container keeps Fluent's layout.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/SplitButton_themeresources.xaml#L104-L119
export const toolbarCss = `
/* A command bar item's label runs at 12, two steps below the 14 Fluent's
   button reset uses; the icon is unaffected, since Fluent sizes the icon slot
   in its own right rather than by inheritance. ToolbarButton contributes no
   class of its own, so the subject is the button root and the toolbar is the
   context that scopes it. That the selector also catches a plain Button or a
   MenuButton trigger placed in a toolbar is the intent rather than overreach:
   WinUI states this typography for a SplitButton because of where it is
   hosted, so every item of the bar carries it, whichever control provides it.
   The line box stays Fluent's 20px. WinUI sets no LineHeight here, and since
   Fluent's medium button takes its height from line box plus padding, pairing
   the 16px step that its own 12px size uses would shrink a toolbar button
   below every other WinUI button beside it — the opposite of the taller
   AppBarThemeCompactHeight this style asks for and the corpus does not define.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/SplitButton_themeresources.xaml#L113
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/SplitButton_themeresources.xaml#L118 */
.fui-Toolbar .fui-Button.fui-Button {
  font-size: 12px;
}
`;
