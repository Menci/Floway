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
import { list, nested, pressedRoots } from './selectors';

const selectedCard = `.fui-Card.fui-Card:has(> .fui-Card__checkbox:checked:enabled)`;

const selectedCardPressed = pressedRoots(selectedCard, '> .fui-Card__checkbox');

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
    background-color: var(--winui-subtle-fill-secondary);
  }

  /* Unlike the Expander fill, the selected wash answers the pointer: Tertiary
     hovered, Secondary pressed. ListViewItemBackgroundSelectedDisabled is
     Secondary through both, and Fluent hands the card's disabled state to the
     hidden checkbox, so :enabled on it is what holds a disabled selected card
     at the rule above.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L21-L22
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L74
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-card/library/src/components/Card/useCardSelectable.ts#L108-L112 */
  ${selectedCard}:hover {
    background-color: var(--winui-subtle-fill-tertiary);
  }

${nested(list(selectedCardPressed))} {
    background-color: var(--winui-subtle-fill-secondary);
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
    box-shadow: inset 0 0 0 1px var(--winui-focus-stroke-inner);
  }
}
`;
