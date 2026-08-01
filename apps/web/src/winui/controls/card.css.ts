// Card restyled from Fluent 2 Web onto WinUI 3.
//
// WinUI has no Card control. Its card-shaped surfaces are the Expander, whose
// header is a CardBackgroundFillColorDefault fill and whose content region is
// the Secondary step of the same ramp, both inside a 1px CardStrokeColorDefault
// border; and ListViewItem, which is where the chromeless surface, the selected
// state and the focus ring come from. Every trait those two contribute is a
// surface trait: a fill, a stroke, or a wash replacing the fill.
//
// Fluent partitions a Card's surface by appearance — `filled` and
// `filled-alternative` paint a fill, `outline` paints a neutral stroke, and
// `subtle` is chromeless — so `winui/appearance` stamps the resolved appearance
// onto the root and each rule below names exactly one variant. `subtle` needs
// no rule here, because the theme layer already carries it: WinUI's chromeless
// surface is the ListViewItem, whose rest, pointer-over and pressed fills are
// SubtleFillColorTransparent, Secondary and Tertiary and whose BorderBrush is
// null, and ../theme.ts points Fluent's three subtle background tokens at that
// same ramp.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L17-L19
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L264
//
// The Expander-derived variants never repaint on pointer, so `filled` and
// `filled-alternative` carry no hover or pressed rule: the Expander header
// declares one background and no pointer-over counterpart to it, where its
// foreground and border state all three. That silence is the fill's own; the
// chromeless variant above washes on pointer because its own dictionary says
// so.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L5-L26
//
// Disabled needs no rule of its own either, and the appearance rules below
// carrying a doubled class over Fluent's single-class disabled atom is what
// produces the WinUI answer. The Expander's Disabled visual state rewrites the
// header's foreground and border and leaves its background alone, and the
// border it names, ExpanderHeaderDisabledBorderBrush, is CardStrokeColorDefault
// — the same stroke as at rest. So a disabled card keeps its fill and its
// stroke, exactly as those rules paint them, while Fluent's disabled
// foreground, which nothing here outranks, lands on the WinUI value through
// ../theme.ts.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L12-L13
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L166-L178
//
// Colour is confined to `@media not (forced-colors: active)`. Fluent answers
// forced colours on the card root with `forced-color-adjust: none` plus a
// literal Highlight fill and HighlightText foreground for the selected and the
// hovered or pressed interactive card, which is what WinUI's own HighContrast
// dictionary says: ListViewItem's selected, selected-pointer-over and
// selected-pressed backgrounds all become SystemColorHighlight there. Those
// Fluent declarations sit on single-class atoms, so every coloured rule below
// would outrank them and leave HighlightText on a near-transparent wash;
// standing aside under forced colours keeps Fluent's answer whole. Geometry
// applies in both modes.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L85-L87
//
// Every painted value is read through a `--winui-card-*` custom property. The
// properties are declared on `:root`, so any ancestor can redefine them for its
// subtree, and setting one to `initial` makes it guaranteed-invalid.
// `[data-winui-card-restyle=off]` below is the layer-wide opt-out documented in
// ../tokens.ts, for a subtree whose surfaces are hand-designed and are not
// meant to follow the layer; this file is where the token half of it is
// declared, alongside the elevations the theme layer flattens. The token half
// is what every rule in this file goes through, rather than the `notOptedOut`
// subject compound the layer also offers, because a `:root` indirection reaches
// the opted-out element itself as well as its subtree, where a
// `:not([data-winui-card-restyle=off] *)` compound reaches only the subtree.
// What it restores is the Fluent value each rule displaces, which is what the
// var() fallbacks name; the rules themselves keep matching, so a trait Fluent
// varies by state comes back at its rest value only — the card fills below are
// the case where that shows.
//
// The focus visual takes the other route open to a redefinition of a Fluent
// token: `var()` with no fallback. Under the opt-out the declaration is invalid
// at computed-value time, and a custom property that is invalid at computed
// value time computes to its inherited value, which for a Fluent theme token is
// the provider's own. Naming a fallback there would instead be a cycle. The
// inner ring beside it is a declaration Fluent does not make, so the same
// invalidity drops it to `box-shadow`'s initial value, which is none.
// https://drafts.csswg.org/css-variables/#guaranteed-invalid
// https://drafts.csswg.org/css-variables/#invalid-at-computed-value-time
export const cardCss = `
:root {
  --winui-card-fill: var(--winui-card-background-fill-default);
  --winui-card-fill-alternative: var(--winui-card-background-fill-secondary);
  --winui-card-stroke: var(--winui-card-stroke-default);
  --winui-card-corner-radius: var(--winui-control-corner-radius);
  --winui-card-selected-fill: var(--winui-subtle-fill-secondary);
  --winui-card-selected-fill-hover: var(--winui-subtle-fill-tertiary);
  --winui-card-focus-stroke: var(--winui-focus-stroke-outer);
  --winui-card-focus-stroke-inner: var(--winui-focus-stroke-inner);
}

[data-winui-card-restyle='off'] {
  --winui-card-fill: initial;
  --winui-card-fill-alternative: initial;
  --winui-card-stroke: initial;
  --winui-card-corner-radius: initial;
  --winui-card-selected-fill: initial;
  --winui-card-selected-fill-hover: initial;
  --winui-card-focus-stroke: initial;
  --winui-card-focus-stroke-inner: initial;
  /* The theme layer flattens the six elevation tokens Fluent composes at
     depths 2, 4 and 8, because WinUI carries depth on inline surfaces with a
     stroke instead of a shadow. An opted-out subtree is hand-designed Fluent
     territory, and the Fluent Card behind each playground message takes the
     filled appearance, which paints shadow4 at rest, shadow8 under the pointer
     once the card is interactive and shadow2 when it is disabled, so the whole
     set is handed back together. Each is Fluent's own composition over Fluent's
     own shadow colours, which the theme layer leaves untouched, so no colour is
     restated here and both schemes are covered by one declaration.
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/tokens/src/utils/shadows.ts#L8-L10
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-card/library/src/components/Card/useCardStyles.styles.ts#L178-L180 */
  --shadow2: 0 0 2px var(--colorNeutralShadowAmbient), 0 1px 2px var(--colorNeutralShadowKey);
  --shadow4: 0 0 2px var(--colorNeutralShadowAmbient), 0 2px 4px var(--colorNeutralShadowKey);
  --shadow8: 0 0 2px var(--colorNeutralShadowAmbient), 0 4px 8px var(--colorNeutralShadowKey);
  --shadow2Brand: 0 0 2px var(--colorBrandShadowAmbient), 0 1px 2px var(--colorBrandShadowKey);
  --shadow4Brand: 0 0 2px var(--colorBrandShadowAmbient), 0 2px 4px var(--colorBrandShadowKey);
  --shadow8Brand: 0 0 2px var(--colorBrandShadowAmbient), 0 4px 8px var(--colorBrandShadowKey);
}

/* Both surfaces this file draws from round at ControlCornerRadius: the Expander
   binds its own CornerRadius to it, and ListViewItemCornerRadius states the
   same 4. That is the radius WinUI gives anything inline, which a card is --
   the overlay radius belongs to surfaces that float. Fluent instead scales the
   radius with the card's size; the fallback is its per-size variable, so opting
   out restores that scaling. The focus ring is a
   border on the same \`::after\`, and Fluent restates the Fluent radius on it
   from a selector no weaker than this one, so the ring is named here too and
   the card keeps one radius whether or not it is focused.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L5
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander.xaml#L26
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L58
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-card/library/src/components/Card/useCardStyles.styles.ts#L34-L38 */
.fui-Card.fui-Card,
.fui-Card.fui-Card::after,
.fui-Card.fui-Card[data-fui-focus-visible]::after,
.fui-Card.fui-Card[data-fui-focus-within]:focus-within::after {
  border-radius: var(--winui-card-corner-radius, var(--fui-Card--border-radius));
}

@media not (forced-colors: active) {
  /* The Expander header: the card fill, and the stroke Fluent leaves
     transparent on a filled card. One fill for every pointer state is the
     point -- the rule outranks Fluent's interactive hover and pressed atoms,
     which is how the surface stops repainting under the pointer.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L5
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L9 */
  .fui-Card.fui-Card[data-winui-appearance='filled'] {
    background-color: var(--winui-card-fill, var(--colorNeutralBackground1));
  }

  .fui-Card.fui-Card[data-winui-appearance='filled']::after {
    border-color: var(--winui-card-stroke, var(--colorTransparentStroke));
  }

  /* The Expander content region, one step down the same ramp, inside the same
     stroke.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L25-L26 */
  .fui-Card.fui-Card[data-winui-appearance='filled-alternative'] {
    background-color: var(--winui-card-fill-alternative, var(--colorNeutralBackground2));
  }

  .fui-Card.fui-Card[data-winui-appearance='filled-alternative']::after {
    border-color: var(--winui-card-stroke, var(--colorTransparentStroke));
  }

  /* An outline card keeps Fluent's transparent body and takes only the card
     stroke, which is what an Expander contributes once its fill is dropped.
     ExpanderHeaderBorderPointerOverBrush and ...PressedBrush are that same
     stroke, so this one rule is also the pointer answer.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L46
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L9-L11 */
  .fui-Card.fui-Card[data-winui-appearance='outline']::after {
    border-color: var(--winui-card-stroke, var(--colorNeutralStroke1));
  }

  /* Selection. A selected ListViewItem replaces its background with
     SubtleFillColorSecondary rather than layering over it, and states one
     selected background whatever the item is filled with, so this rule is not
     partitioned by appearance. Fluent does mark selection on the card root, but
     only with the Griffel atom of its own selected fill -- one per appearance,
     each named by a content hash -- so the hidden checkbox it renders for a
     selectable card is the stable marker and is what this rule keys off. A card
     that supplies a floatingAction instead is given no checkbox and keeps
     Fluent's selected fill. Redefining the four *Selected background tokens on
     the root would cover both sources, at the price of handing those tokens to
     every Fluent element inside the card, which is the trade ./button.css.ts
     declines when it states its accent steps as declarations.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L20
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-card/library/src/components/Card/useCardStyles.styles.ts#L476
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-card/library/src/components/Card/useCardSelectable.ts#L92-L95 */
  .fui-Card.fui-Card:has(> .fui-Card__checkbox:checked) {
    background-color: var(--winui-card-selected-fill, var(--colorNeutralBackground1Selected));
  }

  /* The selected wash is ListViewItem's, and unlike the Expander fill it does
     answer the pointer: SubtleFillColorTertiary while the pointer is over a
     selected item, and back to SubtleFillColorSecondary while it is pressed.
     ListViewItemBackgroundSelectedDisabled is Secondary through both, and
     Fluent hands the card's own \`disabled\` to the hidden checkbox, so
     \`:enabled\` on it is what holds a disabled selected card at the rule
     above.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L21-L22
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L74
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-card/library/src/components/Card/useCardSelectable.ts#L108-L112 */
  .fui-Card.fui-Card:has(> .fui-Card__checkbox:checked:enabled):hover {
    background-color: var(--winui-card-selected-fill-hover, var(--colorNeutralBackground1Selected));
  }

  .fui-Card.fui-Card:has(> .fui-Card__checkbox:checked:enabled):active {
    background-color: var(--winui-card-selected-fill, var(--colorNeutralBackground1Pressed));
  }

  /* The focus visual. A ListViewItem draws a two-ring composite: a 2px outer
     ring in FocusStrokeColorOuter with a 1px FocusStrokeColorInner ring
     immediately inside it. The outer ring is the width and the position
     Fluent's own ring already has, so only its colour is restated; Fluent draws
     that ring as a border on the same \`::after\` that carries the card border,
     which leaves the inner ring to sit inside the outer ring's border box as an
     inset shadow, as on every other item-shaped surface in the layer. The
     redefinition sits on that pseudo-element rather than on the card, so the
     token the ring reads is rewritten where it is read and the card's contents
     keep the value they inherit from the provider. The border-color beside it
     restates Fluent's own declaration verbatim, which is what lifts the ring
     over the appearance strokes above: those name one class more than Fluent's
     focus atom does, and would otherwise paint the card stroke over the ring.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L248-L252
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L29-L30
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L181-L182
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-tabster/src/focus/createFocusOutlineStyle.ts#L65-L71 */
  .fui-Card.fui-Card[data-fui-focus-visible]::after,
  .fui-Card.fui-Card[data-fui-focus-within]:focus-within::after {
    --colorStrokeFocus2: var(--winui-card-focus-stroke);
    border-color: var(--colorStrokeFocus2);
    box-shadow: inset 0 0 0 1px var(--winui-card-focus-stroke-inner);
  }
}
`;
