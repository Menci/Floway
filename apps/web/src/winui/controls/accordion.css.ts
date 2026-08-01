// Accordion restyled from Fluent 2 Web onto WinUI 3.
//
// WinUI's counterpart is the Expander. Fluent draws an accordion as chromeless
// text: a transparent header row over the page surface, and a panel inset from
// the item by a horizontal margin. WinUI draws it as a pair of joined card
// surfaces — the header takes the same CardBackgroundFillColorDefault fill and
// CardStrokeColorDefault stroke the card unit already reads from this
// dictionary, and the content region takes the Secondary step of that ramp
// inside the same stroke, with the edge the two share left unstroked.
//
// The header itself never repaints under the pointer: WinUI resolves the
// header's background, foreground and border to the same brush in the normal,
// pointer-over and pressed visual states. The chevron is the whole of the
// control's pointer feedback, and it reacts to the header being hovered or
// pressed rather than to being hovered itself, which is also how fluent-svelte's
// Expander wires it.
//
// Accordion and AccordionItem declare no CSS in Fluent — their style hooks only
// stamp a class name — so nothing below targets them.
export const accordionCss = `
/* The header surface. It is the ToggleButton's own Background and BorderBrush in
   WinUI, and Fluent's button slot resets background-color to inherit, so a fill
   placed on the header root would be repainted square by the button over the
   root's rounded corners — the fill, the stroke and the radius belong together
   on the button. The card fill and the card stroke are both translucent, hence
   clipping the fill to the padding box so the stroke is not painted over.

   WinUI states one Expander min-height and one leading header inset whatever
   the header holds, so both land on every Fluent size — the size variants are
   Griffel atoms with no public class to select.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L96
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L77
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L80
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L5
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L9
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L14
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L5 */
.fui-AccordionHeader__button.fui-AccordionHeader__button {
  background-color: var(--winui-card-background-fill-default);
  background-clip: padding-box;
  border: 1px solid var(--winui-card-stroke-default);
  border-radius: var(--winui-control-corner-radius);
  min-height: 48px;
  padding-inline-start: 16px;
}

/* An expanded header is joined to the content region below it, so its bottom
   corners square off and the shared edge carries no stroke — WinUI states the
   content region's border thickness as 1,0,1,1 for exactly that reason.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L87 */
.fui-AccordionHeader__button.fui-AccordionHeader__button[aria-expanded='true'] {
  border-end-start-radius: 0;
  border-end-end-radius: 0;
}

/* The chevron surface. WinUI gives it a fixed 32×32 button-shaped box with a
   12px glyph centred in it and rounded like a control; it declares no rest
   fill, which is also the initial value here, so only the box is stated.
   Fluent's trailing variant makes the slot a flex spacer that absorbs the row's
   free space, which would stretch that box and let the pointer fill paint the
   whole remainder of the row, so the box is pinned to its own size instead.
   Fluent's 8px gap toward the row's content becomes a margin, because a padded
   box would let the fill below spill into that gap.
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

/* The chevron turns instead of being swapped. WinUI points it down when the
   Expander is collapsed and up when it is open; Fluent computes that rotation
   itself, but only while it is the one creating the glyph, and the runtime
   chokepoint now supplies a 12px cut in place of the 20px artwork Fluent scales
   down. The timing is Fluent's own, kept as it was -- the WinUI chevron is an
   AnimatedIcon whose curve is not in the dictionaries, so there is nothing to
   transcribe and no reason to invent one. Fluent stops rotating the chevron
   once it is no longer the one creating the glyph, so the turn below is this
   layer's own motion: its timing is stated unconditionally and clamped under
   reduce -- see ../index.ts for the two shapes and which is which.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L280-L281 */
.fui-AccordionHeader__button[aria-expanded='true'] .fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon {
  rotate: 180deg;
}

.fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon {
  transition-property: rotate;
  transition-duration: var(--durationNormal);
  transition-timing-function: ease-out;
}

@media (prefers-reduced-motion: reduce) {
  .fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon {
    transition-duration: 0.01ms;
  }
}

/* Fluent's leading chevron has no WinUI counterpart to take spacing from — the
   Expander always ends its row with the chevron — so the gap Fluent already
   declares is preserved, only moved outside the painted box. Its 8px is the
   same measure as the trailing term of the WinUI chevron margin.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L81 */
.fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon:first-child {
  margin-inline-end: 8px;
}

/* A trailing chevron is the arrangement WinUI does state: an auto-width column
   at the end of the header grid, with the content column taking the rest. The
   auto inline-start margin reproduces that split, and the row gap supplies the
   20px leading term of the chevron margin as the floor it is -- the auto margin
   alone exceeds it while the row has slack and collapses to nothing once the
   content fills the row, which is the one case the margin exists for. It is a
   gap rather than a margin because a header's content is often a bare text
   node, and an anonymous flex item cannot be given a margin. The trailing 8px
   and the resulting zero trailing padding on the row are transcribed
   literally.
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

/* Pointer feedback lives entirely on the chevron, and it answers the whole
   header row rather than the chevron alone — the same wiring fluent-svelte's
   Expander uses. A disabled header is excluded because WinUI's disabled visual
   state restates the chevron's rest brushes. The guard reads the disabled
   attribute alone: Fluent marks the sole open item of a non-collapsible
   Accordion aria-disabled while keeping it an ordinary enabled header
   visually, and WinUI has no state for it either.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L16 */
.fui-AccordionHeader__button:enabled:hover .fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon {
  background-color: var(--winui-subtle-fill-secondary);
}

/* WinUI's pressed subtle fill is lighter than its pointer-over fill, so the
   chevron recedes rather than deepens on press.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L17 */
.fui-AccordionHeader__button:enabled:active .fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon {
  background-color: var(--winui-subtle-fill-tertiary);
}

/* The focus visual. Fluent already draws 2px at a 2px outset, which is WinUI's
   own outer-ring geometry, so the ring's colour is restated through the token
   the ring reads, rewritten on the element that reads it. A shadow spread
   across the two pixels of that outset carries WinUI's second, inner ring.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258 */
.fui-AccordionHeader__button.fui-AccordionHeader__button[data-fui-focus-visible] {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
  box-shadow: 0 0 0 2px var(--winui-focus-stroke-inner);
}

/* The content region: the Secondary step of the card ramp, inside the same
   stroke as the header, flush with it and unstroked along the edge the two
   share. Fluent insets the panel from the item instead, which a joined surface
   cannot keep. The bottom-only rounding is the shape fluent-svelte's Expander
   arrives at as well; WinUI states it through the control template rather than
   the theme dictionary, so only the radius value is taken from XAML.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L25
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L26
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L86
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L87
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L5 */
.fui-AccordionPanel.fui-AccordionPanel {
  margin: 0;
  padding: 16px;
  background-color: var(--winui-card-background-fill-secondary);
  background-clip: padding-box;
  border: 1px solid var(--winui-card-stroke-default);
  border-block-start: none;
  border-end-start-radius: var(--winui-control-corner-radius);
  border-end-end-radius: var(--winui-control-corner-radius);
}
`;
