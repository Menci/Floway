// Card restyled from Fluent 2 Web onto WinUI 3. WinUI has no Card control: the
// fill ramp and stroke come from the Expander header and content region, the
// chromeless surface, selected state and focus ring from ListViewItem.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L17-L19
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L264
//
// Three variants are deliberately unwritten. `subtle` is already covered by
// ../theme.ts; `filled` and `filled-alternative` take no hover or pressed rule
// because the Expander header declares no pointer-over background; disabled
// moves only the foreground, which ../theme.ts already lands.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L5-L26
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L166-L178
//
// Colour stays inside `@media not (forced-colors: active)`: WinUI's own forced
// colours answer sits on single-class Fluent atoms that every coloured rule
// here would outrank. Geometry applies in both modes.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L85-L87
//
// Painted values go through `--winui-card-*` so `[data-winui-card-restyle=off]`
// (../tokens.ts) can set each to `initial` and let the var() fallback name the
// Fluent value the rule displaced — token indirection rather than the layer's
// `notOptedOut` subject compound, because `:root` reaches the opted-out element
// itself and not only its subtree.
// https://drafts.csswg.org/css-variables/#guaranteed-invalid
//
// The focus visual instead redefines a Fluent token through a fallback-less
// `var()`, which under the opt-out computes to the provider's inherited value.
// Naming a fallback there would be a cycle.
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
  /* The theme layer flattens the six elevation tokens Fluent composes, because
     WinUI carries depth on inline surfaces with a stroke instead of a shadow.
     An opted-out subtree is Fluent territory, so the whole set is recomposed
     over Fluent's own shadow colours.
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/tokens/src/utils/shadows.ts#L8-L10
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-card/library/src/components/Card/useCardStyles.styles.ts#L178-L180 */
  --shadow2: 0 0 2px var(--colorNeutralShadowAmbient), 0 1px 2px var(--colorNeutralShadowKey);
  --shadow4: 0 0 2px var(--colorNeutralShadowAmbient), 0 2px 4px var(--colorNeutralShadowKey);
  --shadow8: 0 0 2px var(--colorNeutralShadowAmbient), 0 4px 8px var(--colorNeutralShadowKey);
  --shadow2Brand: 0 0 2px var(--colorBrandShadowAmbient), 0 1px 2px var(--colorBrandShadowKey);
  --shadow4Brand: 0 0 2px var(--colorBrandShadowAmbient), 0 2px 4px var(--colorBrandShadowKey);
  --shadow8Brand: 0 0 2px var(--colorBrandShadowAmbient), 0 4px 8px var(--colorBrandShadowKey);
}

/* Both surfaces this file draws from round at ControlCornerRadius, the radius
   WinUI gives anything inline, where Fluent scales the radius with the card's
   size. The focus ring is a border on the same pseudo-element and Fluent
   restates its radius from a selector no weaker than this one, so the ring is
   named here too and the card keeps one radius focused or not.
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
  /* The Expander header. The doubled class outranks Fluent's hover and pressed
     atoms, which is how the surface stops repainting under the pointer.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L5
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L9 */
  .fui-Card.fui-Card[data-winui-appearance='filled'] {
    background-color: var(--winui-card-fill, var(--colorNeutralBackground1));
  }

  .fui-Card.fui-Card[data-winui-appearance='filled']::after {
    border-color: var(--winui-card-stroke, var(--colorTransparentStroke));
  }

  /* The Expander content region, one step down the same ramp.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L25-L26 */
  .fui-Card.fui-Card[data-winui-appearance='filled-alternative'] {
    background-color: var(--winui-card-fill-alternative, var(--colorNeutralBackground2));
  }

  .fui-Card.fui-Card[data-winui-appearance='filled-alternative']::after {
    border-color: var(--winui-card-stroke, var(--colorTransparentStroke));
  }

  /* An outline card takes only the card stroke, which is what an Expander
     contributes once its fill is dropped. Its pointer-over and pressed strokes
     are that same stroke, so this one rule is also the pointer answer.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L46
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L9-L11 */
  .fui-Card.fui-Card[data-winui-appearance='outline']::after {
    border-color: var(--winui-card-stroke, var(--colorNeutralStroke1));
  }

  /* A selected ListViewItem replaces its background and states one selected
     background whatever the item is filled with, so this rule is not
     partitioned by appearance. Fluent marks selection on the root only through
     a content-hashed Griffel atom, so the hidden checkbox it renders for a
     selectable card is the stable marker keyed off here. A card that supplies a
     floatingAction instead gets no checkbox and keeps Fluent's selected fill;
     covering it would mean redefining the four *Selected tokens on the root,
     handing them to every Fluent element inside the card.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L20
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-card/library/src/components/Card/useCardStyles.styles.ts#L476
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-card/library/src/components/Card/useCardSelectable.ts#L92-L95 */
  .fui-Card.fui-Card:has(> .fui-Card__checkbox:checked) {
    background-color: var(--winui-card-selected-fill, var(--colorNeutralBackground1Selected));
  }

  /* Unlike the Expander fill, the selected wash answers the pointer: Tertiary
     hovered, Secondary pressed. ListViewItemBackgroundSelectedDisabled is
     Secondary through both, and Fluent hands the card's disabled state to the
     hidden checkbox, so :enabled on it is what holds a disabled selected card
     at the rule above.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L21-L22
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L74
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-card/library/src/components/Card/useCardSelectable.ts#L108-L112 */
  .fui-Card.fui-Card:has(> .fui-Card__checkbox:checked:enabled):hover {
    background-color: var(--winui-card-selected-fill-hover, var(--colorNeutralBackground1Selected));
  }

  .fui-Card.fui-Card:has(> .fui-Card__checkbox:checked:enabled):active {
    background-color: var(--winui-card-selected-fill, var(--colorNeutralBackground1Pressed));
  }

  /* A ListViewItem draws a 2px outer ring with a 1px inner ring immediately
     inside it; Fluent's own ring already has the outer width and position, so
     only its colour is restated, and the inner ring is an inset shadow. The
     redefinition sits on the pseudo-element so the card's contents keep the
     token value they inherit from the provider. The border-color beside it
     restates Fluent's own declaration verbatim, which is what lifts the ring
     over the appearance strokes above: those name one class more than Fluent's
     focus atom does and would otherwise paint over it.
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
