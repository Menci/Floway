// Card restyled from Fluent 2 Web onto WinUI 3. WinUI has no Card control: the
// fill ramp and stroke come from the Expander header and content region, the
// chromeless surface and focus ring from ListViewItem.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L17-L19
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L264
//
// `filled` and `filled-alternative` take no hover or pressed rule because the
// Expander header declares no pointer-over background, and a disabled card
// moves only the foreground, which ../theme.ts already lands.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L5-L26
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L166-L178
//
// Colour stays inside `@media not (forced-colors: active)`: WinUI's own forced
// colours answer sits on single-class Fluent atoms that every coloured rule
// here would outrank. Geometry applies in both modes. The one forced-colours
// rule at the foot of this file is where the two languages disagree.

export const cardCss = `
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
  border-radius: var(--winui-control-corner-radius);
}

/* A card's stroke is drawn as an absolutely positioned overlay carrying no
   stacking order of its own, so it sits at the foot of the positioned layer and
   anything positioned inside the card paints over it -- a sticky band spanning
   the card erased the three edges it reached. The card is also only relative,
   not a stacking context, so those numbers were competing with the whole
   document rather than with their own card.

   Both are stated here: the card contains its contents' stacking order, and its
   own boundary is the last thing it draws. The number means nothing outside the
   card, which is the point -- content inside cannot reach it, and cannot reach
   anything outside either. */
.fui-Card.fui-Card {
  isolation: isolate;
}

.fui-Card.fui-Card::after {
  z-index: 99;
}

@media not (forced-colors: active) {
  /* The Expander header. The doubled class outranks Fluent's hover and pressed
     atoms, which is how the surface stops repainting under the pointer.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L5
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L9 */
  .fui-Card.fui-Card[data-winui-appearance='filled'] {
    background-color: var(--winui-card-background-fill-default);
  }

  .fui-Card.fui-Card[data-winui-appearance='filled']::after {
    border-color: var(--winui-card-stroke-default);
  }

  /* The Expander content region, one step down the same ramp.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L25-L26 */
  .fui-Card.fui-Card[data-winui-appearance='filled-alternative'] {
    background-color: var(--winui-card-background-fill-secondary);
  }

  .fui-Card.fui-Card[data-winui-appearance='filled-alternative']::after {
    border-color: var(--winui-card-stroke-default);
  }

  /* An outline card takes only the card stroke, which is what an Expander
     contributes once its fill is dropped. Its pointer-over and pressed strokes
     are that same stroke, so this one rule is also the pointer answer.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L46
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L9-L11 */
  .fui-Card.fui-Card[data-winui-appearance='outline']::after {
    border-color: var(--winui-card-stroke-default);
  }

  /* The chromeless surface. ../theme.ts already lands its rest fill through
     colorSubtleBackground, but Fluent's disabled atom repaints the card in an
     opaque grey and strokes it, and neither WinUI surface this file draws from
     repaints on disable: the Expander's Disabled state carries no Background
     keyframe and resolves its border to the same CardStrokeColorDefault the
     enabled header uses, and the default ListViewItem style declares no border
     at all. Restating the rest surface at the specificity the other appearances
     already carry is what keeps the disabled card transparent and unstroked.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L17
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L234-L266
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L13
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L166-L178 */
  .fui-Card.fui-Card[data-winui-appearance='subtle'] {
    background-color: var(--winui-subtle-fill-transparent);
  }

  .fui-Card.fui-Card[data-winui-appearance='subtle']::after {
    border-color: transparent;
  }

  /* A ListViewItem draws a 2px outer ring with a 1px inner ring immediately
     inside it; Fluent's own ring already has the outer width, position and
     colour token, so only the inner ring is added, as an inset shadow. The
     border-color beside it restates Fluent's own declaration verbatim, which is
     what lifts the ring over the appearance strokes above: those name one class
     more than Fluent's focus atom does and would otherwise paint over it.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L248-L252
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L29-L30
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L181-L182
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-tabster/src/focus/createFocusOutlineStyle.ts#L65-L71 */
  .fui-Card.fui-Card[data-fui-focus-visible]::after,
  .fui-Card.fui-Card[data-fui-focus-within]:focus-within::after {
    border-color: var(--colorStrokeFocus2);
    box-shadow: inset 0 0 0 var(--winui-focus-visual-secondary-thickness) var(--winui-focus-stroke-inner);
  }
}

/* High Contrast. Fluent strokes a selectable or interactive card in Highlight
   before it is touched: in useCardStyles the after key of highContrastInteractive
   is a sibling of the state it reads as, not nested inside it, so the accent
   lands at rest. WinUI spends SystemColorHighlight on
   an item's pointer-over, pressed and selected fills alone and gives a card
   stroke SystemColorWindowText, which is CanvasText here; its HighContrast
   dictionary names no item border brush at all. So the rest stroke is the same
   one a card that answers nothing already gets from the user agent.

   The pointer states Fluent fills with Highlight are excluded, because a stroke
   of the same colour as the fill is the borderless item WinUI draws and
   CanvasText would outline it; focus is excluded so Fluent's ring keeps the
   pseudo-element.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L464
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L80-L100
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-card/library/src/components/Card/useCardStyles.styles.ts#L354-L386
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
@media (forced-colors: active) {
  .fui-Card.fui-Card:not(:hover):not(:active):not([data-fui-focus-visible]):not([data-fui-focus-within]:focus-within)::after {
    border-color: CanvasText;
  }
}
`;
