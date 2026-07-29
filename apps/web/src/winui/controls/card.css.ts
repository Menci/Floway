// Card restyled from Fluent 2 Web onto WinUI 3.
//
// WinUI has no Card control. Its card-shaped surfaces are the Expander, whose
// header is a CardBackgroundFillColorDefault fill and whose content region is
// the Secondary step of the same ramp, both inside a 1px CardStrokeColorDefault
// border; and ListViewItem, which is where the selected state and the focus
// ring come from. Every trait those two contribute is a surface trait: a fill,
// a stroke, or a wash replacing the fill.
//
// Fluent partitions a Card's surface by appearance — `filled` and
// `filled-alternative` paint a fill, `outline` paints a neutral stroke, and
// `subtle` is chromeless — so `winui/appearance` stamps the resolved appearance
// onto the root and each rule below names exactly one variant. `subtle` gets no
// fill and no stroke, because WinUI states no chrome for a surface that has
// declared itself chromeless.
//
// WinUI never repaints a card surface on pointer, so there is no hover or
// pressed rule here: the Expander header declares one background and no
// pointer-over counterpart to it.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L5-L26
//
// Every painted value is read through a `--winui-card-*` custom property. The
// properties are declared on `:root`, so any ancestor can redefine them for its
// subtree, and setting one to `initial` makes it guaranteed-invalid.
// `[data-winui-card-restyle=off]` below is the layer-wide opt-out documented in
// ../tokens.ts, for a subtree whose surfaces are hand-designed and are not
// meant to follow the layer; this file is where the token half of it is
// declared, alongside the elevations the theme layer flattens. What the opt-out
// restores is the Fluent value each rule displaces, which is what the var()
// fallbacks name; the rules themselves keep matching,
// so a trait Fluent varies by state comes back at its rest value only — the
// card fills below are the case where that shows.
//
// The focus visual takes the other route open to a redefinition of a Fluent
// token: `var()` with no fallback. Under the opt-out the declaration is invalid
// at computed-value time, and a custom property that is invalid at computed
// value time computes to its inherited value, which for a Fluent theme token is
// the provider's own. Naming a fallback there would instead be a cycle.
// https://drafts.csswg.org/css-variables/#guaranteed-invalid
// https://drafts.csswg.org/css-variables/#invalid-at-computed-value-time
export const cardCss = `
:root {
  --winui-card-fill: var(--winui-card-background-fill-default);
  --winui-card-fill-alternative: var(--winui-card-background-fill-secondary);
  --winui-card-stroke: var(--winui-card-stroke-default);
  --winui-card-corner-radius: var(--winui-overlay-corner-radius);
  --winui-card-selected-fill: var(--winui-subtle-fill-secondary);
  --winui-card-focus-stroke: var(--winui-focus-stroke-outer);
}

[data-winui-card-restyle='off'] {
  --winui-card-fill: initial;
  --winui-card-fill-alternative: initial;
  --winui-card-stroke: initial;
  --winui-card-corner-radius: initial;
  --winui-card-selected-fill: initial;
  --winui-card-focus-stroke: initial;
  /* The theme layer flattens Fluent's six ambient elevations, because WinUI
     carries depth on inline surfaces with a stroke instead of a shadow. The
     chat composer was designed against those elevations and reads as a raised
     bar because of them, so the opted-out subtree gets every one of them back.
     Each is Fluent's own composition over Fluent's own shadow colours, which
     the theme layer leaves untouched, so no colour is restated here and both
     schemes are covered by one declaration.
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/tokens/src/utils/shadows.ts#L3-L5 */
  --shadow2: 0 0 2px var(--colorNeutralShadowAmbient), 0 1px 2px var(--colorNeutralShadowKey);
  --shadow4: 0 0 2px var(--colorNeutralShadowAmbient), 0 2px 4px var(--colorNeutralShadowKey);
  --shadow8: 0 0 2px var(--colorNeutralShadowAmbient), 0 4px 8px var(--colorNeutralShadowKey);
  --shadow2Brand: 0 0 2px var(--colorBrandShadowAmbient), 0 1px 2px var(--colorBrandShadowKey);
  --shadow4Brand: 0 0 2px var(--colorBrandShadowAmbient), 0 2px 4px var(--colorBrandShadowKey);
  --shadow8Brand: 0 0 2px var(--colorBrandShadowAmbient), 0 4px 8px var(--colorBrandShadowKey);
}

/* WinUI gives every card-shaped surface the same OverlayCornerRadius, where
   Fluent scales the radius with the card's size; the fallback is Fluent's own
   per-size variable, so opting out restores that scaling.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L6 */
.fui-Card.fui-Card,
.fui-Card.fui-Card::after {
  border-radius: var(--winui-card-corner-radius, var(--fui-Card--border-radius));
}

/* The Expander header: the card fill, and the stroke Fluent leaves transparent
   on a filled card. One fill for every pointer state is the point — the rule
   outranks Fluent's interactive hover and pressed atoms, which is how the
   surface stops repainting under the pointer.
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
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L46 */
.fui-Card.fui-Card[data-winui-appearance='outline']::after {
  border-color: var(--winui-card-stroke, var(--colorNeutralStroke1));
}

/* Selection. A selected ListViewItem replaces its background with
   SubtleFillColorSecondary rather than layering over it, and states one
   selected background whatever the item is filled with, so this rule is not
   partitioned by appearance. Fluent exposes selection to CSS only through the
   checkbox it renders as a child of the card root, so a card whose selection
   is driven by a floating action instead has no selector to match.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L20
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-card/library/src/components/Card/useCardSelectable.ts#L92-L118 */
.fui-Card.fui-Card:has(> .fui-Card__checkbox:checked) {
  background-color: var(--winui-card-selected-fill, var(--colorNeutralBackground1Selected));
}

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
.fui-Card.fui-Card[data-fui-focus-visible]::after,
.fui-Card.fui-Card[data-fui-focus-within]:focus-within::after {
  --colorStrokeFocus2: var(--winui-card-focus-stroke);
}
`;
