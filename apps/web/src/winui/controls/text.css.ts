// Text and Divider, restyled from Fluent 2 Web onto WinUI 3.
//
// Text contributes no rule. Fluent's `fui-Text` declares typography and layout
// only — family, the size/line-height ramp, weight, alignment, wrapping and
// truncation — and WinUI's theme resources state no type scale to diff those
// against, only per-control font sizes. Its colour is inherited, and the
// ambient foreground is already WinUI's: the theme layer re-points
// `colorNeutralForeground1/2/3` at the TextFillColor ramp, so a foreground rule
// here would restate a value that layer already resolves. Text is the most
// widely used component in this app, which makes an invented type ramp the most
// visible mistake available; the absence of one is deliberate.
//
// Divider contributes one. Fluent draws the rule as a `border-*-color` on the
// root's two pseudo-elements at `strokeWidthThin` — 1px, the same hairline
// WinUI gives AppBarSeparator — so colour is all that is left to state, and
// only for the `default` appearance, the one WinUI has a counterpart brush for.
export const textCss = `
/* WinUI names exactly one divider brush, so only Fluent's default appearance --
   the one reading colorNeutralStroke2 -- has something to move onto; subtle,
   strong and brand read other tokens and keep the ramp the theme layer has
   already carried over. That appearance reaches the DOM as a hashed atom, so
   rather than name it, the token it reads is redeclared on the two
   pseudo-elements that consume it. Declaring it there instead of on the root
   keeps the remap off caller-supplied divider children, which are the root's
   descendants but not the pseudo-elements'. One declaration serves both
   orientations, since horizontal and vertical differ only in which border side
   reads the token.

   A separator carries no state to derive: AppBarSeparator's template states
   layout states alone -- no pointer, selection or disabled state -- so a colour
   per theme is the whole surface.

   Light already agrees, so this is a dark-theme correction: the theme layer
   maps colorNeutralStroke2 to the card outline, which in dark is black, while
   WinUI's divider is a white wash. Forced colours need no counterpart of their
   own: the HighContrast dictionary points the divider brush at the window text
   colour, which is what a forced border-color already resolves to.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L53
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L257
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L471
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/AppBarSeparator_themeresources.xaml#L28-L48
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
.fui-Divider.fui-Divider::before,
.fui-Divider.fui-Divider::after {
  --colorNeutralStroke2: var(--winui-divider-stroke-default);
}

/* Selection highlight. WinUI keys the band behind selected text to the accent
   and the glyphs over it to TextOnAccentFillColorSelectedText, and both
   dictionaries state the same pair, so the highlight does not flip with the
   theme. Every text-editing style -- TextBox, RichEditBox, PasswordBox,
   AutoSuggestBox, NumberBox -- points its SelectionHighlightColor at the
   background half; the foreground half is named by no template at all. The web
   has one selection for the whole document rather than one per control, so what
   WinUI restates in each of those styles is stated once here, which also
   reaches static text, for which no dictionary states anything.

   A selection either exists or does not: there is no pointer, focus or disabled
   variant of it to derive. Forced colours take the pair over, force-adjusting
   both properties to the palette's own selection colours, and that is the same
   hand-off WinUI's HighContrast dictionary makes when it drops the accent from
   both keys in favour of system colours.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L11
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L215
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L425
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L452
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L183
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
::selection {
  background-color: var(--winui-accent-fill-selected-text-background);
  color: var(--winui-text-on-accent-fill-selected-text);
}
`;
