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
// WinUI draws — so only the colour diverges, and only for the `default`
// appearance, the one WinUI has a counterpart brush for.
export const textCss = `
/* WinUI names exactly one divider brush, so only Fluent's default appearance —
   the one reading colorNeutralStroke2 — has something to move onto; subtle,
   strong and brand read other tokens and keep the ramp the theme layer has
   already carried over. That appearance reaches the DOM as a hashed atom, so
   rather than name it, the token it reads is redeclared on the two
   pseudo-elements that consume it. Declaring it there instead of on the root
   keeps the remap off caller-supplied divider children, which are the root's
   descendants but not the pseudo-elements'.

   Light already agrees, so this is a dark-theme correction: the theme layer
   maps colorNeutralStroke2 to the card outline, which in dark is black, while
   WinUI's divider is a white wash.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L53
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L257 */
.fui-Divider.fui-Divider::before,
.fui-Divider.fui-Divider::after {
  --colorNeutralStroke2: var(--winui-divider-stroke-default);
}
`;
