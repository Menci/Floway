// Accordion restyled onto WinUI 3's Expander: the header takes the default card
// fill and stroke, the content region the Secondary step of that ramp, and the
// edge the two share is left unstroked.
//
// The header slab never repaints under the pointer -- no ExpanderHeaderBackground*
// key exists for any state -- and the light and dark dictionaries are
// byte-identical, so every colour here is a theme token and no rule below is
// written per scheme.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L4-L51
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L103-L110
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L122-L129
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L144-L151
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L185-L192
import { notDisabled, reducedMotion } from './selectors';

export const accordionCss = `
/* The fill, the stroke and the radius belong on the button rather than the
   header root: Fluent's button slot resets background-color to inherit, so a
   fill on the root would be repainted square by the button over the root's
   rounded corners.

   WinUI's Expander declares no size variant, so the single min-height, the
   leading header inset and the header type are stated unconditionally, which
   overrides the 32px min-height Fluent gives its small header and the per-size
   type it gives the small, large and extra-large ones. WinUI's header is a
   ToggleButton carrying the Header as its content and states no font size of
   its own, so it takes the 14 ControlContentThemeFontSize gives every button.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L96
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L77
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L80
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L5
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L9
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L14
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander.xaml#L111
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L36
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L5995
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L5 */
.fui-AccordionHeader__button.fui-AccordionHeader__button {
  background-color: var(--winui-card-background-fill-default);
  border: 1px solid var(--winui-card-stroke-default);
  border-radius: var(--winui-control-corner-radius);
  font-size: var(--fontSizeBase300);
  line-height: var(--lineHeightBase300);
  min-height: 48px;
  padding-inline-start: 16px;
}

/* An expanded header is joined to the content region below it, so its bottom
   corners square off and the shared edge carries no stroke -- WinUI states the
   content region's border thickness as 1,0,1,1 for exactly that reason.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L87 */
.fui-AccordionHeader__button.fui-AccordionHeader__button[aria-expanded='true'] {
  border-end-start-radius: 0;
  border-end-end-radius: 0;
}

/* Fluent's trailing variant makes the chevron slot a flex spacer that absorbs
   the row's free space, which would stretch the box and let the pointer fill
   paint the whole remainder of the row, so the box is pinned to its own size.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L81
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L84
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L85
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L280 */
.fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon {
  flex: 0 0 auto;
  inline-size: 32px;
  block-size: 32px;
  justify-content: center;
  padding: 0;
  font-size: 12px;
  border-radius: var(--winui-control-corner-radius);
}

/* Fluent computes the chevron's rotation itself, but only while it is the one
   creating the glyph, and the runtime chokepoint now supplies a 12px cut in
   place of the 20px artwork Fluent scales down -- see ../index.ts. So the turn
   is stated below, unconditionally and clamped under reduce, on the shared
   AnimatedIcon timing declared in ../motion.ts. */
.fui-AccordionHeader__button[aria-expanded='true'] .fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon {
  rotate: 180deg;
}

.fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon {
  transition-property: rotate;
  transition-duration: var(--winui-chevron-turn-duration);
  transition-timing-function: var(--winui-chevron-turn-easing);
}

${reducedMotion(['.fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon'], 'transition-duration')}

/* Fluent's leading chevron has no WinUI counterpart to take spacing from -- the
   Expander always ends its row with the chevron -- so the gap Fluent already
   declares is preserved, only moved outside the painted box.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L81 */
.fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon:first-child {
  margin-inline-end: 8px;
}

/* WinUI ends the header grid with an auto-width chevron column, the content
   column taking the rest. The auto inline-start margin reproduces that split,
   and the row gap supplies the 20px leading term of the chevron margin as the
   floor it is -- the auto margin alone exceeds it while the row has slack and
   collapses to nothing once the content fills the row. Its price is that the row
   gap also lands between an icon slot and the header text, where Fluent states
   8px.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L98-L99
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L81
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L80 */
.fui-AccordionHeader__button.fui-AccordionHeader__button:has(> .fui-AccordionHeader__expandIcon:last-child) {
  column-gap: 20px;
  padding-inline-end: 0;
}

.fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon:last-child {
  margin-inline-start: auto;
  margin-inline-end: 8px;
}

/* Pointer feedback lives entirely on the chevron and answers the whole header
   row rather than the chevron alone, which is how fluent-svelte's Expander
   wires it too. A header that cannot be actuated is
   excluded, because WinUI's disabled visual state puts the chevron's rest brush
   back. Fluent reaches that state two ways: a disabled AccordionItem, rendered
   with the native attribute, and the sole open item of a non-collapsible
   Accordion, left natively enabled and marked aria-disabled with its chrome
   ungrayed. Both stop the toggle, so both drop the feedback.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L12
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L16
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L166-L184
   https://github.com/tropicaaal/fluent-svelte/blob/ba1813ecc0797117be0e1b24be3a3c4905111ba7/src/lib/Expander/Expander.scss#L89-L95 */
.fui-AccordionHeader__button${notDisabled}:hover .fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon {
  background-color: var(--winui-subtle-fill-secondary);
}

/* WinUI's pressed subtle fill is lighter than its pointer-over fill, so the
   chevron recedes rather than deepens on press.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L17 */
.fui-AccordionHeader__button${notDisabled}:active .fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon {
  background-color: var(--winui-subtle-fill-tertiary);
}

/* The user agent's forced adjustment reaches most of WinUI's HighContrast map on
   its own. What it cannot reach is the pointer state, painted in Highlight here,
   and the two strokes thickened to 2px.

   A media query adds no specificity, so the two unconditional rules below
   restate their subject's selector exactly and win on source order alone. The
   pointer rules need no such restatement: the state they name is not written
   anywhere else on the button.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L52-L77
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
@media (forced-colors: active) {
  .fui-AccordionHeader__button.fui-AccordionHeader__button {
    border-width: 2px;
  }

  .fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon {
    border: 2px solid ButtonText;
  }

  .fui-AccordionHeader__button.fui-AccordionHeader__button${notDisabled}:hover,
  .fui-AccordionHeader__button.fui-AccordionHeader__button${notDisabled}:active {
    color: Highlight;
    border-color: Highlight;
  }

  .fui-AccordionHeader__button${notDisabled}:hover .fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon,
  .fui-AccordionHeader__button${notDisabled}:active .fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon {
    border-color: Highlight;
  }
}

/* Fluent already draws WinUI's outer-ring geometry, so only the ring's colour is
   restated. WinUI's second ring sits immediately against the control, inside the
   first, and an inset shadow is the way to land it there: an inner shadow is
   clipped to the padding box, so its pixel falls just inside the band the outer
   ring covers. Under forced colours the shadow is dropped by the user agent and
   Fluent's own literal system colour carries the ring.

   Fluent also blanks the header's own border while the ring shows, and the
   Expander template has no focus visual state at all -- its header keeps
   ExpanderHeaderBorderBrush focused or not -- so the stroke is restated here at
   the weight that blanking rule ties.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L9
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
.fui-AccordionHeader__button.fui-AccordionHeader__button[data-fui-focus-visible] {
  border-color: var(--winui-card-stroke-default);
  box-shadow: inset 0 0 0 var(--winui-focus-visual-secondary-thickness) var(--winui-focus-stroke-inner);
}

/* Fluent insets the panel from the item, which a joined surface cannot keep, so
   the region sits flush inside the same stroke as the header. Like
   fluent-svelte's Expander, the bottom-only rounding is unconditional and only
   the header's bottom squares off on expansion.
   https://github.com/tropicaaal/fluent-svelte/blob/ba1813ecc0797117be0e1b24be3a3c4905111ba7/src/lib/Expander/Expander.scss#L10-L22
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L25
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L26
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L86
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L87
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L5 */
.fui-AccordionPanel.fui-AccordionPanel {
  margin: 0;
  padding: 16px;
  background-color: var(--winui-card-background-fill-secondary);
  border: 1px solid var(--winui-card-stroke-default);
  border-block-start: none;
  border-end-start-radius: var(--winui-control-corner-radius);
  border-end-end-radius: var(--winui-control-corner-radius);
}
`;
