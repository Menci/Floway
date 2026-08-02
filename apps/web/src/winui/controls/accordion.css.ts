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
// In the dark and light dictionaries the header slab itself never repaints
// under the pointer. No ExpanderHeaderBackground* key exists for any state --
// the header Grid is fed once through TemplateBinding -- and the foreground and
// border keys the normal, pointer-over, pressed and expanded states name all
// resolve to the same two brushes. The two dictionaries are byte-identical
// entry for entry, so every colour here is a theme token and no rule below is
// written per scheme. Disabled is the exception the states above do not cover:
// it does repaint the foreground, to TextFillColorDisabled.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L4-L51
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L103-L110
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L122-L129
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L144-L151
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L185-L192
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L166
//
// The chevron is the whole of the control's pointer feedback, and it reacts to
// the header being hovered or pressed rather than to being hovered itself,
// which is also how fluent-svelte's Expander wires it.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L16
// https://github.com/tropicaaal/fluent-svelte/blob/ba1813ecc0797117be0e1b24be3a3c4905111ba7/src/lib/Expander/Expander.scss#L89-L95
//
// HighContrast breaks both halves and is stated in a block of its own below:
// there the header's foreground and border do swap to the Highlight colour
// under the pointer, and the header's stroke is ButtonText where the content
// region's is WindowText.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L52-L74
//
// Accordion and AccordionItem declare no CSS in Fluent — their style hooks only
// stamp a class name — so nothing below targets them.
export const accordionCss = `
/* The header surface. It is the ToggleButton's own Background and BorderBrush in
   WinUI, and Fluent's button slot resets background-color to inherit, so a fill
   placed on the header root would be repainted square by the button over the
   root's rounded corners -- the fill, the stroke and the radius belong together
   on the button. The card fill and the card stroke are both translucent, so the
   fill has to stop at the border rather than run under it; ../reset.css.ts
   already clips every element that way.

   WinUI's Expander declares no size variant: one min-height and one leading
   header inset, whatever the header holds. Both are stated unconditionally
   here, which overrides the 32px min-height Fluent gives its small header --
   Fluent's leading inset is already the same at every size.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L96
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L77
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L80
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L5
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L9
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L14
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CornerRadius_themeresources.xaml#L5 */
.fui-AccordionHeader__button.fui-AccordionHeader__button {
  background-color: var(--winui-card-background-fill-default);
  border: 1px solid var(--winui-card-stroke-default);
  border-radius: var(--winui-control-corner-radius);
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

/* The chevron surface. WinUI gives it a fixed 32×32 button-shaped box with a
   12px glyph centred in it and rounded like a control; it declares no rest
   fill, which is also the initial value here, so only the box is stated.
   Fluent's trailing variant makes the slot a flex spacer that absorbs the row's
   free space, which would stretch that box and let the pointer fill paint the
   whole remainder of the row, so the box is pinned to its own size instead.
   Fluent's 8px gap toward the row's content becomes a margin, which is where
   WinUI puts it: ExpanderChevronMargin states 20,0,8,0 outside a 32px
   ExpanderChevronButtonSize box, so the gap is clear of the pointer fill and
   the glyph stays centred in the box.
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

/* The chevron turns instead of being swapped. WinUI points it down when the
   Expander is collapsed and up when it is open; Fluent computes that rotation
   itself, but only while it is the one creating the glyph, and the runtime
   chokepoint now supplies a 12px cut in place of the 20px artwork Fluent scales
   down. Fluent stops rotating the chevron once it is no longer the one creating
   the glyph, so the turn is stated below: unconditionally, and clamped under
   reduce -- see ../index.ts for the two shapes and which is which.

   Its timing is WinUI's own. The chevron is an AnimatedIcon, so the numbers are
   not in the theme dictionaries but in the generated visual source, whose
   4.3333s composition runs at 60fps and is cut into named state segments. The
   two segments that carry this rotation, NormalOffToNormalOn and
   NormalOnToNormalOff, each spend ten of those frames turning -- 167ms, on the
   cubic Bezier through (0.167, 0.167) and (0, 1). The turn is symmetric for
   that reason, and the Expander's own asymmetric open and close stay with the
   region they time.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L280-L282
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedChevronUpDownSmallVisualSource.cpp#L104
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedChevronUpDownSmallVisualSource.cpp#L352
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedChevronUpDownSmallVisualSource.cpp#L428-L440
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/AnimatedIcon/AnimatedVisuals/AnimatedChevronUpDownSmallVisualSource.cpp#L789-L796 */
.fui-AccordionHeader__button[aria-expanded='true'] .fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon {
  rotate: 180deg;
}

.fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon {
  transition-property: rotate;
  transition-duration: 167ms;
  transition-timing-function: cubic-bezier(0.167, 0.167, 0, 1);
}

@media (prefers-reduced-motion: reduce) {
  .fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon {
    transition-duration: 0.01ms;
  }
}

/* Fluent's leading chevron has no WinUI counterpart to take spacing from -- the
   Expander always ends its row with the chevron -- so the gap Fluent already
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
   content fills the row, which is the one case the margin exists for. The 20px
   rides on the row rather than on the chevron because the chevron's own
   inline-start margin is spent on that auto, which is what reproduces the split
   after Fluent's grow spacer was pinned above. Its price is that the row gap
   also lands between an icon slot and the header text, where Fluent states 8px.
   The trailing 8px and the resulting zero trailing padding on the row are
   transcribed literally.
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
   header row rather than the chevron alone -- the same wiring fluent-svelte's
   Expander uses (linked in the module header above). A header that cannot be actuated is excluded, because WinUI's
   disabled visual state puts the chevron's rest brush back. Fluent reaches that
   state two ways: a disabled AccordionItem, which it renders with the native
   attribute, and the sole open item of a non-collapsible Accordion, which it
   leaves natively enabled and marks aria-disabled while keeping the header's
   chrome ungrayed. Both stop the toggle, so both drop the feedback.

   The graying of the first of those two is Fluent's: it colours the header root
   with the disabled foreground token, which theme.ts points at
   TextFillColorDisabled -- WinUI's ExpanderHeaderDisabledForeground, which the
   disabled state gives to the label and the chevron glyph alike -- and the
   button's inherited colour carries it to both. Nothing here writes a colour on
   either, so nothing here outranks it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L12
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L16
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L166-L184 */
.fui-AccordionHeader__button:enabled:not([aria-disabled='true']):hover .fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon {
  background-color: var(--winui-subtle-fill-secondary);
}

/* WinUI's pressed subtle fill is lighter than its pointer-over fill, so the
   chevron recedes rather than deepens on press.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L17 */
.fui-AccordionHeader__button:enabled:not([aria-disabled='true']):active .fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon {
  background-color: var(--winui-subtle-fill-tertiary);
}

/* Forced colours. WinUI answers Windows High Contrast with a theme dictionary
   that maps each of these brushes onto a system colour, and the user agent's
   forced adjustment reaches most of that map on its own: the header's fill and
   stroke resolve to ButtonFace and ButtonText, the content region's to Canvas
   and CanvasText, and a disabled header's label and glyph to the disabled text
   colour of the button they sit in. The chevron's two pointer fills resolve the
   same way but keep the alpha they were written with, a few percent, so they
   land on the untinted chevron this dictionary states rather than on a fill.

   What the adjustment cannot reach is the rest of the pointer state, which this
   dictionary alone paints in Highlight, and the two strokes it alone thickens
   to 2px -- the border-box sizing this app resets to keeps that thickness
   inside the 32px chevron and the 48px row.

   A media query adds no specificity, so the two unconditional rules below
   restate their subject's selector exactly and win on source order alone. The
   pointer rules need no such restatement: the state they name is not written
   anywhere else on the button, so they carry more weight than the rest rules
   they displace and stand on their own.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Expander/Expander_themeresources.xaml#L52-L77
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
@media (forced-colors: active) {
  .fui-AccordionHeader__button.fui-AccordionHeader__button {
    border-width: 2px;
  }

  .fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon {
    border: 2px solid ButtonText;
  }

  .fui-AccordionHeader__button.fui-AccordionHeader__button:enabled:not([aria-disabled='true']):hover,
  .fui-AccordionHeader__button.fui-AccordionHeader__button:enabled:not([aria-disabled='true']):active {
    color: Highlight;
    border-color: Highlight;
  }

  .fui-AccordionHeader__button:enabled:not([aria-disabled='true']):hover .fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon,
  .fui-AccordionHeader__button:enabled:not([aria-disabled='true']):active .fui-AccordionHeader__expandIcon.fui-AccordionHeader__expandIcon {
    border-color: Highlight;
  }
}

/* The focus visual. Fluent already draws 2px at a 2px outset, which is WinUI's
   own outer-ring geometry, so the ring's colour is restated through the token
   the ring reads, rewritten on the element that reads it. WinUI's second ring
   sits immediately against the control, inside the first, and an inset shadow
   is the way to land it there: an inner shadow is clipped to the padding box,
   so its pixel falls just inside the band the outer ring covers instead of
   outside it. Under forced colours the shadow is dropped by the user agent and
   Fluent's own literal system colour carries the ring.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54-L55
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258-L259
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
.fui-AccordionHeader__button.fui-AccordionHeader__button[data-fui-focus-visible] {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
  box-shadow: inset 0 0 0 1px var(--winui-focus-stroke-inner);
}

/* The content region: the Secondary step of the card ramp, inside the same
   stroke as the header, flush with it and unstroked along the edge the two
   share. Fluent insets the panel from the item instead, which a joined surface
   cannot keep. The bottom-only rounding is the shape fluent-svelte's Expander
   arrives at as well; WinUI states it through the control template rather than
   the theme dictionary, so only the radius value is taken from XAML. Note that
   fluent-svelte rounds the content region unconditionally and squares only the
   header's bottom on expansion; the panel rule here is unconditional for the
   same reason.
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
