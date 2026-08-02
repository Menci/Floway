// Card restyled from Fluent 2 Web onto WinUI 3.
//
// WinUI has no Card control. Its card-shaped surfaces are the Expander, whose
// header and content region are the two steps of the card ramp inside a 1px
// CardStrokeColorDefault border, and ListViewItem, which is where the
// chromeless surface, the selected state and the focus ring come from.
//
// `winui/appearance` stamps the resolved appearance onto the root and each rule
// below names exactly one variant. `subtle` needs no rule here, because
// ../theme.ts already points Fluent's three subtle background tokens at the
// ListViewItem ramp.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L17-L19
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L264
//
// The Expander-derived variants never repaint on pointer, so `filled` and
// `filled-alternative` carry no hover or pressed rule: the Expander header
// declares one background and no pointer-over counterpart to it.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L5-L26
//
// Disabled needs no rule of its own: the Expander's Disabled visual state
// leaves both the header's background and, through
// ExpanderHeaderDisabledBorderBrush, its stroke where rest put them, and the
// appearance rules below carry a doubled class over Fluent's single-class
// disabled atom, so they stand. Only the foreground moves, and ../theme.ts
// already lands Fluent's on the WinUI value.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L12-L13
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L166-L178
//
// Colour is confined to `@media not (forced-colors: active)`. Fluent's forced
// colours answer — `forced-color-adjust: none` plus a literal Highlight fill —
// is what WinUI's own HighContrast dictionary says, but it sits on single-class
// atoms, so every coloured rule below would outrank it and leave HighlightText
// on a near-transparent wash. Geometry applies in both modes.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L85-L87
//
// Every painted value is read through a `--winui-card-*` custom property, so
// that `[data-winui-card-restyle=off]` — the layer-wide opt-out documented in
// ../tokens.ts — can set each to `initial` and make it guaranteed-invalid,
// leaving the var() fallback to name the Fluent value the rule displaced. This
// file goes through the token indirection rather than the `notOptedOut` subject
// compound the layer also offers, because `:root` reaches the opted-out element
// itself as well as its subtree where the compound reaches only the subtree.
// The rules keep matching either way, so a trait Fluent varies by state comes
// back at its rest value only.
//
// The focus visual takes the other route open to a redefinition of a Fluent
// token: `var()` with no fallback, which under the opt-out is invalid at
// computed-value time and so computes to the inherited value — the provider's
// own. Naming a fallback there would instead be a cycle.
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
  /* The theme layer flattens the six elevation tokens Fluent composes at depths
     2, 4 and 8, because WinUI carries depth on inline surfaces with a stroke
     instead of a shadow. An opted-out subtree is Fluent territory, so the whole
     set is handed back together, recomposed over Fluent's own shadow colours
     which the theme layer leaves untouched.
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
   WinUI gives anything inline; the overlay radius belongs to surfaces that
   float. Fluent instead scales the radius with the card's size, which the
   fallback restores under the opt-out. The focus ring is a border on the same
   \`::after\` and Fluent restates its radius from a selector no weaker than this
   one, so the ring is named here too and the card keeps one radius whether or
   not it is focused.
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
     transparent on a filled card. The rule outranks Fluent's interactive hover
     and pressed atoms, which is how the surface stops repainting under the
     pointer.
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

  /* Selection. A selected ListViewItem replaces its background rather than
     layering over it, and states one selected background whatever the item is
     filled with, so this rule is not partitioned by appearance. Fluent marks
     selection on the card root only through the Griffel atom of its own
     selected fill -- one per appearance, each named by a content hash -- so the
     hidden checkbox it renders for a selectable card is the stable marker this
     rule keys off. A card that supplies a floatingAction instead is given no
     checkbox and keeps Fluent's selected fill; covering that too would mean
     redefining the four *Selected tokens on the root, handing them to every
     Fluent element inside the card.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L20
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-card/library/src/components/Card/useCardStyles.styles.ts#L476
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-card/library/src/components/Card/useCardSelectable.ts#L92-L95 */
  .fui-Card.fui-Card:has(> .fui-Card__checkbox:checked) {
    background-color: var(--winui-card-selected-fill, var(--colorNeutralBackground1Selected));
  }

  /* The selected wash is ListViewItem's, and unlike the Expander fill it does
     answer the pointer: Tertiary while hovered, back to Secondary while
     pressed. ListViewItemBackgroundSelectedDisabled is Secondary through both,
     and Fluent hands the card's own \`disabled\` to the hidden checkbox, so
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

  /* The focus visual. A ListViewItem draws a 2px outer ring with a 1px inner
     ring immediately inside it. The outer ring is the width and position
     Fluent's own ring already has, so only its colour is restated, and the inner
     ring sits inside that border box as an inset shadow. The redefinition sits
     on the pseudo-element rather than on the card, so the card's contents keep
     the token value they inherit from the provider. The border-color beside it
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
