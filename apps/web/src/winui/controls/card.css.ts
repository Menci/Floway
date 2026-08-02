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

const enabledCard = ".fui-Card.fui-Card:not([aria-disabled='true'])";

const selectedCard = `${enabledCard}[data-winui-selected='true']`;

const unselectedCard = `${enabledCard}[data-winui-selected='false']`;

const selectedCardPressed = pressedRoots(selectedCard, '> .fui-Card__checkbox');

const unselectedCardPressed = pressedRoots(unselectedCard, '> .fui-Card__checkbox');

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
  /* WinUI holds an item's foreground still through every pointer and selection
     state: ListViewItemForeground and its PointerOver, Pressed, Selected,
     SelectedPointerOver and SelectedPressed siblings are one brush,
     TextFillColorPrimaryBrush. Fluent instead drops an interactive
     filled-alternative card from colorNeutralForeground1 to
     colorNeutralForeground2Hover on hover, which is a move between ramps rather
     than within one, so mapping the sibling tokens in ../theme.ts cannot reach
     it. Stating the fill once on the enabled card outranks every appearance's
     hover atom; the disabled card is excluded because its own foreground is a
     single-class atom that ../theme.ts already lands.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L23-L28
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L175-L180
     https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-card/library/src/components/Card/useCardStyles.styles.ts#L225-L242 */
  ${enabledCard} {
    color: var(--winui-text-fill-primary);
  }

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

  /* A selectable card is a ListViewItem, not an Expander: it answers the
     pointer whether or not it is selected, and it states one selected
     background whatever the item is filled with, so none of these rules is
     partitioned by appearance. The stamp ../appearance.ts writes is the marker,
     because Fluent's own selected state reaches the DOM only as a
     content-hashed atom and, on a card that supplies a floatingAction, as
     nothing at all. Every rule names the state it answers rather than relying
     on the one after it, and the disabled row is excluded from the pointer
     steps outright: ListViewItemBackgroundSelectedDisabled is the Secondary
     rest fill through hover and press alike.
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L18-L22
     https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/ListViewItem_themeresources.xaml#L74 */
  ${unselectedCard}:hover {
    background-color: var(--winui-subtle-fill-secondary);
  }

${nested(list(unselectedCardPressed))} {
    background-color: var(--winui-subtle-fill-tertiary);
  }

  .fui-Card.fui-Card[data-winui-selected='true'] {
    background-color: var(--winui-subtle-fill-secondary);
  }

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
