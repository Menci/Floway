// Card restyled from Fluent 2 Web onto WinUI 3.
//
// WinUI has no Card control. Its card-shaped surfaces are the Expander header —
// a CardBackgroundFillColorDefault fill inside a 1px CardStrokeColorDefault
// border — and ListViewItem, which is where the selected and pointer states
// come from. Every trait those two contribute is a surface trait: a fill, a
// stroke, or a wash over both.
//
// Fluent partitions a Card's surface by appearance, and it partitions it in
// atoms: `filled` and `filled-alternative` paint a fill, `outline` paints a
// neutral stroke, `subtle` is chromeless, and each writes `background-color`
// and an `::after` border colour under a hashed class. `winui/appearance`
// stamps the resolved appearance back onto the DOM for the components it
// wraps, and Card is not one of them, so no selector in this file can name one
// appearance. A fill or a stroke stated on `.fui-Card` would consequently land
// on the chromeless appearances WinUI itself leaves bare, and would repaint
// every Card in the app — including the hand-designed chat bubbles, which use
// a plain Card as their container and own their look.
//
// The focus stroke is the one Card trait that survives that: WinUI states a
// single focus visual for the card-shaped item whatever it is filled with, and
// Fluent draws it on one pseudo-element shared by all four appearances.
export const cardCss = `
/* The focus visual. A ListViewItem draws its primary focus ring in
   FocusStrokeColorOuter at 2px, which is the width and the position Fluent's
   own ring already has, so the ring's colour is the only input left to state.
   WinUI's 1px FocusStrokeColorInner ring inside it is left out: Fluent draws
   the ring on the same \`::after\` that carries the card border, and there is no
   second layer on the root to put an inner ring on without inventing one.
   The redefinition sits on that pseudo-element rather than on the card, so the
   token the ring reads is rewritten where it is read and the card's contents
   keep the value they inherit from the provider; the forced-colors override
   Fluent pairs with the ring is a literal system colour and is unaffected.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L248-L252
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L29-L30
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L181-L182
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258 */
.fui-FluentProvider .fui-Card[data-fui-focus-visible]::after,
.fui-FluentProvider .fui-Card[data-fui-focus-within]:focus-within::after {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
}
`;
