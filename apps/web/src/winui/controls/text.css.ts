// Text and Divider, restyled from Fluent 2 Web onto WinUI 3.
//
// Text contributes no rule: WinUI states no type scale to diff Fluent's ramp
// against, and text colour is already inherited from the theme layer's
// TextFillColor remap. The absence of an invented type ramp is deliberate.
export const textCss = `
/* WinUI names exactly one divider brush, so only Fluent's default appearance --
   the one reading colorNeutralStroke2 -- has something to move onto. That
   appearance reaches the DOM as a hashed atom, so the token it reads is
   redeclared rather than the class named, and it is declared on the two
   pseudo-elements that consume it instead of on the root, which keeps the remap
   off caller-supplied divider children.

   Light already agrees, so this is a dark-theme correction: the theme layer
   maps colorNeutralStroke2 to the card outline, which in dark is black, while
   WinUI's divider is a white wash.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L53
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L257
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L471
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/AppBarSeparator_themeresources.xaml#L28-L48 */
.fui-Divider.fui-Divider::before,
.fui-Divider.fui-Divider::after {
  --colorNeutralStroke2: var(--winui-divider-stroke-default);
}

/* Selection highlight. WinUI keys the band behind selected text to the accent
   and the glyphs over it to TextOnAccentFillColorSelectedText, and both
   dictionaries state the same pair, so the highlight does not flip with the
   theme. Every text-editing style restates the background half and no template
   names the foreground half; the web has one selection per document, so both
   are stated once here, which also reaches static text.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L11
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L215
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L425
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L452
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L183 */
::selection {
  background-color: var(--winui-accent-fill-selected-text-background);
  color: var(--winui-text-on-accent-fill-selected-text);
}
`;
