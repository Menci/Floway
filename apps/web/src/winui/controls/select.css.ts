// WinUI 3 ComboBox styling for Fluent v9's Dropdown, Combobox, Listbox and
// Option. Fluent paints these as a Fluent 2 Web field — opaque background,
// uniform neutral outline, brand underline on focus — while WinUI paints a
// translucent control fill inside a directional elevation stroke, answers
// keyboard focus with a detached ring and an accent pill on the faceplate
// rather than with the underline, and marks the selected list item with the
// same accent pill instead of a check glyph alone.
//
// The field rules address `[data-winui-appearance='outline']`, the appearance
// whose Fluent form — opaque fill inside a full outline — is the one WinUI's
// ComboBox has. Fluent's `underline`, `filled-lighter` and `filled-darker`
// fields have no WinUI counterpart and are left as Fluent draws them.
//
// The WinUI ComboBox dictionary declares one key set and resolves it per theme,
// so each rule below is written once against a theme-aware `--winui-*`
// variable rather than duplicated per color scheme: its Light and its Default
// dictionary differ only in the legacy `*ThemeBrush` compatibility resources,
// none of which the current template reads.
//
// Windows High Contrast is transcribed for the drop-down list at the end of
// this sheet, because the HighContrast dictionary collapses every item fill
// onto Highlight with a HighlightText foreground -- a state table Fluent's
// option does not state at all, so forced colours would otherwise leave the
// list with one appearance. The field keeps the border Fluent already paints
// there, and the multiselect check box keeps Fluent's forced-colours drawing
// for the reason ./choice.css.ts writes down for every check box.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L110-L136
//
// The Dropdown button's root and the Combobox root carry the same border and
// fill in Fluent, so they are addressed as one selector list throughout.
export const selectCss = `
/* Field shell at rest. WinUI fills the ComboBox with a translucent control fill
   over whatever sits behind it, where Fluent paints an opaque neutral.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L32 */
.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline'],
.fui-Combobox.fui-Combobox[data-winui-appearance='outline'] {
  background-color: var(--winui-control-fill-default);
}

/* The rest outline is WinUI's directional elevation stroke rather than a
   uniform neutral plus a darker bottom edge.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L54 */
.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:not(:has(.fui-Dropdown__button[aria-invalid='true'])),
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']:not(:has(.fui-Combobox__input[aria-invalid='true'])) {
  border-color: var(--winui-control-elevation-border-color);
}

/* The placeholder runs its own three-step ramp: secondary at rest, over and
   focused, tertiary while the field is pressed or open, and the disabled text
   fill once the field is disabled. The pressed and disabled steps have to be
   stated because the rest rule outweighs both Fluent's own pressed value and
   its disabled atom.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L48
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L49
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L52 */
.fui-Combobox__input.fui-Combobox__input::placeholder {
  color: var(--winui-text-fill-secondary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L50 */
.fui-Combobox:active .fui-Combobox__input.fui-Combobox__input:enabled::placeholder,
.fui-Combobox__input.fui-Combobox__input:enabled[aria-expanded='true']::placeholder {
  color: var(--winui-text-fill-tertiary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L51 */
.fui-Combobox__input.fui-Combobox__input:disabled::placeholder {
  color: var(--winui-text-fill-disabled);
}

/* Hover. WinUI moves the fill one step down the control-fill ramp and leaves
   the elevation stroke alone; Fluent does the opposite, holding the fill and
   brightening the outline.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L33
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L55 */
.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:hover,
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']:hover {
  background-color: var(--winui-control-fill-secondary);
}

.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:hover:not(:has(.fui-Dropdown__button[aria-invalid='true'])),
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']:hover:not(:has(.fui-Combobox__input[aria-invalid='true'])) {
  border-color: var(--winui-control-elevation-border-color);
}

/* Keyboard focus. WinUI leaves the field's own fill and stroke alone and lights
   two things beside it: a separate highlight border inset by -4px around the
   control, two pixels of the outer focus stroke drawn at its own 7px corner,
   and the accent pill on the faceplate's leading edge -- the same pill the
   selected list item carries, stated once and shown by both. An outline
   reproduces the border -- a 2px offset puts the stroke's outer edge at the
   same 4px out -- except for that corner: the ring is carried by an outline
   rather than by the ::after this appearance frees below, and an outline takes
   the field's radius plus its own offset, so the corner lands a pixel tighter
   than WinUI's fixed 7px. That pixel is the price of the carrier. Fluent's
   keyboard-modality data attribute keeps pointer focus in the pressed/rest
   states while still finding the button or input inside each root -- WinUI
   splits the same way, giving pointer focus an empty PointerFocused state.
   Fluent's brand underline is the affordance this replaces, so the
   pseudo-element drawing it is dropped on the appearance WinUI paints. The
   field draws no inner focus ring: it opts out of the system focus visual --
   UseSystemFocusVisuals binds to IsApplicationFocusVisualKindReveal, which is
   False in every dictionary -- so the FocusStrokeColorInner half of that pair
   has no owner here. The whole visual is HighlightBackground, a border inset
   -4 whose 2px stroke is FocusStrokeColorOuter and whose fill is
   ControlFillColorDefault. The outline carries that stroke; the shadow spread
   across the two pixels the outline is offset by carries the fill, which is
   what shows between the stroke and the field. The two brushes coincide in
   light, where each is 70% white, and part in dark, where the control fill is
   6% white against an inner ring's 70% black.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L37
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L38
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L338
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L343
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L380
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L570
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L473-L476
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L504
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L328 */
.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:has([data-fui-focus-visible]),
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']:has([data-fui-focus-visible]) {
  box-shadow: 0 0 0 2px var(--winui-control-fill-default);
  outline: 2px solid var(--winui-focus-stroke-outer);
  outline-offset: 2px;
}

/* The faceplate pill. WinUI states it at a flat 16px against the item's own
   pill style, a pixel in from the field's leading edge and centred on the row.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L324
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L325
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L346
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L572 */
.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:has([data-fui-focus-visible])::before,
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']:has([data-fui-focus-visible])::before {
  background-color: var(--winui-accent-fill-default);
  border-radius: 1.5px;
  content: '';
  height: 16px;
  inset-inline-start: 1px;
  pointer-events: none;
  position: absolute;
  top: 50%;
  translate: 0 -50%;
  width: 3px;
}

.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']::after,
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']::after {
  content: none;
}

/* Fluent also swaps the field border to its pressed stroke while focus is
   inside, where WinUI's Focused state leaves the border brush untouched, so the
   rest stroke is restated against it. No invalid exclusion is needed: Fluent's
   own invalid border is written against :not(:focus-within).
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L473-L487 */
.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:focus-within,
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']:focus-within {
  border-color: var(--winui-control-elevation-border-color);
}

/* Pressed, which for a ComboBox is also the open state: WinUI drops to the
   tertiary fill, flattens the elevation stroke to a uniform default stroke, and
   dims the text one step.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L34
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L56 */
.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:active,
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']:active,
.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:has(.fui-Dropdown__button[aria-expanded='true']),
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']:has(.fui-Combobox__input[aria-expanded='true']) {
  background-color: var(--winui-control-fill-tertiary);
}

.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:active:not(:has(.fui-Dropdown__button[aria-invalid='true'])),
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']:active:not(:has(.fui-Combobox__input[aria-invalid='true'])),
.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:has(.fui-Dropdown__button[aria-expanded='true']),
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']:has(.fui-Combobox__input[aria-expanded='true']) {
  border-color: var(--winui-control-stroke-default);
}

/* An open ComboBox is in the same pressed state, so its label dims with the
   fill. WinUI dims it whatever the field looks like, so this one is not tied to
   an appearance. A disabled field can still take :active on the root -- the
   pointer event lands on the wrapper rather than the control -- so the enabled
   guard keeps the disabled text fill Fluent paints on a single class.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L42
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L43 */
.fui-Dropdown:active .fui-Dropdown__button.fui-Dropdown__button:enabled,
.fui-Combobox:active .fui-Combobox__input.fui-Combobox__input:enabled,
.fui-Dropdown__button.fui-Dropdown__button:enabled[aria-expanded='true'],
.fui-Combobox__input.fui-Combobox__input:enabled[aria-expanded='true'] {
  color: var(--winui-text-fill-secondary);
}

/* Disabled. WinUI keeps a visible fill and the ordinary default stroke rather
   than going transparent behind a lightened outline the way Fluent does.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L35
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L57 */
.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:has(.fui-Dropdown__button:disabled),
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']:has(.fui-Combobox__input:disabled) {
  background-color: var(--winui-control-fill-disabled);
  border-color: var(--winui-control-stroke-default);
}

/* The glyphs need the disabled text fill restated because the glyph rule below
   outweighs Fluent's own disabled icon colour; the labels do not, since Fluent
   already paints them with the token this theme maps onto that same fill.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L59 */
.fui-Dropdown:has(.fui-Dropdown__button:disabled) .fui-Dropdown__expandIcon.fui-Dropdown__expandIcon,
.fui-Dropdown:has(.fui-Dropdown__button:disabled) .fui-Dropdown__clearButton.fui-Dropdown__clearButton,
.fui-Combobox:has(.fui-Combobox__input:disabled) .fui-Combobox__expandIcon.fui-Combobox__expandIcon,
.fui-Combobox:has(.fui-Combobox__input:disabled) .fui-Combobox__clearIcon.fui-Combobox__clearIcon {
  color: var(--winui-text-fill-disabled);
}

/* The drop-down glyph. WinUI fixes it at 12px in the secondary text fill,
   where Fluent scales it with the field size and paints it in the accessible
   stroke colour.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L58
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L582 */
.fui-Dropdown__expandIcon.fui-Dropdown__expandIcon,
.fui-Combobox__expandIcon.fui-Combobox__expandIcon {
  color: var(--winui-text-fill-secondary);
  font-size: 12px;
  height: 12px;
  width: 12px;
}

/* The clear affordance is Fluent's own -- WinUI's ComboBox has no such button
   -- but it sits in the glyph's place and takes the colour WinUI gives the
   buttons inside a text control, so the pair reads as one. Its geometry stays
   Fluent's apart from the trailing inset it inherits with that place, set
   below.

   Fluent renders both slots by default and hides them with display:none until
   the field is clearable, so these selectors match on every non-multiselect
   Dropdown and Combobox in the app and paint on none of them. They are kept
   for the day a field asks for the affordance rather than because anything
   shows one today.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L45
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-combobox/library/src/components/Dropdown/useDropdown.tsx#L98-L113 */
.fui-Dropdown__clearButton.fui-Dropdown__clearButton,
.fui-Combobox__clearIcon.fui-Combobox__clearIcon {
  color: var(--winui-text-fill-secondary);
}

/* WinUI reads the content inset off the ComboBox padding and the glyph's own
   trailing margin: no trailing padding on the field, 14px between the glyph and
   the field edge, and a leading inset stated twice -- 12px for the presenter a
   read-only ComboBox shows, 11px for the TextBox an editable one swaps in. The
   Dropdown is the read-only form and the Combobox the editable one, so each
   takes its own number. WinUI's trailing 38px belongs to that TextBox spanning
   both template columns; Fluent gives the input a column of its own, so the
   glyph's margin carries the whole trailing inset.
   Fluent divides the inset differently on each control -- the Dropdown puts all
   of it on the inner button, the Combobox splits it across root, input and icon
   -- so both are restated here. Each control swaps its clear affordance into
   the glyph's place rather than beside it, so the affordance takes the same
   trailing inset, and the Combobox icon's hit-area extension is re-anchored to
   the margin it now has to span.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L341
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L342
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L580
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L582 */
.fui-Dropdown__button.fui-Dropdown__button {
  padding-block: 5px 7px;
  padding-inline: 12px 0;
}

.fui-Combobox.fui-Combobox {
  padding-inline-end: 0;
}

.fui-Combobox__input.fui-Combobox__input {
  padding-inline: 11px 0;
}

.fui-Dropdown__expandIcon.fui-Dropdown__expandIcon,
.fui-Dropdown__clearButton.fui-Dropdown__clearButton,
.fui-Combobox__expandIcon.fui-Combobox__expandIcon,
.fui-Combobox__clearIcon.fui-Combobox__clearIcon {
  margin-inline-end: 14px;
}

.fui-Combobox__expandIcon.fui-Combobox__expandIcon::after,
.fui-Combobox__clearIcon.fui-Combobox__clearIcon::after {
  inset-inline-end: -14px;
}

/* The drop-down surface. WinUI gives the popup the overlay radius and a real
   flyout stroke, against Fluent's control radius and transparent outline.
   The WinUI fill is AcrylicInAppFillColorDefaultBrush, taken as the flat
   FallbackColor that brush declares for itself -- what WinUI paints when
   transparency effects are off -- because the flyout surfaces in this layer do
   no backdrop compositing. Fluent's flat white is a full step brighter than
   either reading of the drop-down WinUI draws.
   BackgroundSizing is InnerBorderEdge, which ../reset.css.ts already applies to
   everything: the fill stops at the border so the translucent stroke reads
   against whatever the drop-down floats over, as on every other flyout in the
   layer.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L63
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L64
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/Materials/Acrylic/AcrylicBrush_themeresources.xaml#L96
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L332
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L590 */
.fui-Listbox.fui-Listbox,
.fui-Dropdown__listbox.fui-Dropdown__listbox,
.fui-Combobox__listbox.fui-Combobox__listbox {
  background-color: var(--winui-acrylic-in-app-fill-default);
  border-color: var(--winui-surface-stroke-flyout);
  border-radius: var(--winui-overlay-corner-radius);
  gap: 0;
  overflow: hidden;
  padding: 0;
}

/* Fluent keeps the positioned Listbox as the ARIA and event root. Its public
   render slot inserts this existing viewport so OverlayScrollbars can own the
   scrolling surface without reparenting React's Options or changing the
   active-descendant search root. Floating UI writes a constrained height to
   the outer root; flex propagates that height to the viewport, while max-height
   keeps the unconstrained content path intrinsic.
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-combobox/library/src/components/Combobox/useCombobox.tsx#L43-L74
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-positioning/library/src/middleware/maxSize.ts#L43-L70
   https://github.com/KingSora/OverlayScrollbars/blob/79fc9549843635ac1627b34685b1209e621ac5d2/packages/overlayscrollbars/README.md#L124-L171 */
.floway-combobox-listbox-viewport {
  flex: 1 1 auto;
  max-height: inherit;
  min-height: 0;
  width: 100%;
}

.floway-combobox-listbox-content {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
}

/* List items. WinUI uses a tighter corner -- ComboBoxItemCornerRadius, stated
   for this item alone rather than as a step of the shared radius pair -- and an
   asymmetric padding that sits the label optically centred against the taller
   bottom inset.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L345
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L335
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L345 */
.fui-Option.fui-Option {
  border-radius: 3px;
  padding-block: 5px 7px;
  padding-inline: 11px;
}

/* Item states run on the subtle-fill ramp, which washes over the drop-down
   surface rather than replacing it with a neutral background the way Fluent's
   NeutralBackground1Hover/Pressed do. WinUI also dims the label on press. A
   disabled item runs neither state -- its fill is the transparent step of the
   same ramp -- and Fluent agrees, withholding its interactive atom entirely,
   so these carry the guard that keeps them from outranking it. Its label is
   left to Fluent for the reason the field's labels are: WinUI's disabled item
   foreground is the disabled text fill, and Fluent's own token for it already
   resolves there.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L16
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L7
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L17
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L8 */
.fui-Option.fui-Option:not([aria-disabled='true']):hover {
  background-color: var(--winui-subtle-fill-secondary);
  color: var(--winui-text-fill-primary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L15
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L6 */
.fui-Option.fui-Option:not([aria-disabled='true']):active {
  background-color: var(--winui-subtle-fill-tertiary);
  color: var(--winui-text-fill-secondary);
}

/* Selection. Fluent leaves the selected item visually identical to the rest and
   lets the check glyph carry the state; WinUI keeps a standing subtle wash and
   inverts the interaction pair against it, so a selected item goes one step
   lighter on hover where an unselected item goes one step darker. A disabled
   selected item keeps that standing wash, which is the rest value, so the
   enabled guard on the pair above is all a disabled item needs. A multiselect
   listbox reports its options as menuitemcheckbox rather than option, so each
   rule takes the checked state alongside the selected one.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L18
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L20
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L21
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L22 */
.fui-Option.fui-Option[aria-selected='true'],
.fui-Option.fui-Option[aria-checked='true'] {
  background-color: var(--winui-subtle-fill-secondary);
}

.fui-Option.fui-Option[aria-selected='true']:not([aria-disabled='true']):hover,
.fui-Option.fui-Option[aria-checked='true']:not([aria-disabled='true']):hover {
  background-color: var(--winui-subtle-fill-tertiary);
}

.fui-Option.fui-Option[aria-selected='true']:not([aria-disabled='true']):active,
.fui-Option.fui-Option[aria-checked='true']:not([aria-disabled='true']):active {
  background-color: var(--winui-subtle-fill-secondary);
}

/* The accent selection pill on the item's leading edge. WinUI draws it as a
   Rectangle in the template's first grid column; here it is the item's own
   ::before, which is free because Fluent spends ::after on the
   active-descendant focus ring. A multiselect option gets no pill: WinUI's
   ComboBox has no multiselect form, and Fluent's checkbox there is a control of
   its own rather than a second reading of the same state.
   WinUI states the pill as a fixed 16px on its 32px item. Our choice is to
   state it as a proportion instead: a quarter inset at each end, which is that
   same 16px on the 32px item this file builds and keeps the pill in proportion
   when an Option carries multi-line content.

   One brush serves every state the pill appears in, disabled included, so the
   fill is declared once.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L106
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L324
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L325
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L346
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L759 */
.fui-Option.fui-Option[aria-selected='true']::before {
  background-color: var(--winui-accent-fill-default);
  border-radius: 1.5px;
  content: '';
  inset-block: 25%;
  inset-inline-start: 0;
  pointer-events: none;
  position: absolute;
  width: 3px;
}

/* Pressing a selected item shortens its pill to ComboBoxItemPillMinScale about
   its own centre, over 167ms on the cubic Bezier through (0, 0) and (0, 1).
   The timing rides the pressed rule rather than the pill's own, because WinUI
   registers a key frame on the way in and none on the way out: the scale snaps
   back when the state ends.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L326
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L330
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L726-L728 */
.fui-Option.fui-Option[aria-selected='true']:not([aria-disabled='true']):active::before {
  scale: 1 0.625;
  transition: scale 167ms cubic-bezier(0, 0, 0, 1);
}

@media (prefers-reduced-motion: reduce) {
  .fui-Option.fui-Option[aria-selected='true']:not([aria-disabled='true']):active::before {
    transition-duration: 0.01ms;
  }
}

/* The pill is WinUI's whole single-select indicator, so the check glyph Fluent
   shows in the same role goes -- and so does the column it sat in. WinUI's item
   is a label against the item's own padding with the pill drawn inside that
   inset, not beside it, so keeping the glyph's space would indent every label
   in the list past where the template puts it. The rule is scoped to the option
   role a single-select listbox writes, so a multiselect option keeps the
   checkbox Fluent draws in that slot -- the control the pill deliberately does
   not stand in for.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L759
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-combobox/library/src/components/Option/useOption.tsx#L115-L117 */
.fui-Option[aria-selected] .fui-Option__checkIcon.fui-Option__checkIcon {
  display: none;
}

/* The check box a multiselect option keeps, on WinUI's own state table rather
   than Fluent's. WinUI moves the interior a step down the alt-fill ramp on
   pointer-over and on press, holds ControlStrongStrokeColorDefault while
   unchecked and drops that outline to the disabled strong stroke under the
   pointer; once checked, the stroke IS the accent fill, so the box reads as a
   filled square with no outline, and both walk the accent ramp together
   through pointer-over and pressed. A disabled box takes the disabled step of
   whichever fill its state uses behind that same neutral disabled stroke.
   Fluent instead brightens the stroke on hover, keeps a neutral outline around
   the checked box, and states its disabled colours on single classes these
   rules would outrank.

   Colour is confined to the not-forced-colours query below, for the reason
   ./choice.css.ts writes down for every check box: an accent-filled indicator
   under forced colours also needs forced-color-adjust: none, which this layer
   does not take on, so forced colours keeps Fluent's drawing.

   ./choice.css.ts states the same table for the check box control. An option
   draws its box from a different slot, so it is restated here rather than
   inherited.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L41-L44
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L45-L48
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L53-L56
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L57-L60
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L69-L72 */
@media not (forced-colors: active) {
  .fui-Option[aria-checked='false'] .fui-Option__checkIcon.fui-Option__checkIcon {
    background-color: var(--winui-control-alt-fill-secondary);
    border-color: var(--winui-control-strong-stroke-default);
  }

  .fui-Option[aria-checked='false']:not([aria-disabled='true']):hover
    .fui-Option__checkIcon.fui-Option__checkIcon {
    background-color: var(--winui-control-alt-fill-tertiary);
    border-color: var(--winui-control-strong-stroke-default);
  }

  .fui-Option[aria-checked='false']:not([aria-disabled='true']):active
    .fui-Option__checkIcon.fui-Option__checkIcon {
    background-color: var(--winui-control-alt-fill-quarternary);
    border-color: var(--winui-control-strong-stroke-disabled);
  }

  .fui-Option[aria-checked='true'] .fui-Option__checkIcon.fui-Option__checkIcon {
    background-color: var(--winui-accent-fill-default);
    border-color: var(--winui-accent-fill-default);
    color: var(--winui-text-on-accent-fill-primary);
  }

  .fui-Option[aria-checked='true']:not([aria-disabled='true']):hover
    .fui-Option__checkIcon.fui-Option__checkIcon {
    background-color: var(--winui-accent-fill-secondary);
    border-color: var(--winui-accent-fill-secondary);
  }

  .fui-Option[aria-checked='true']:not([aria-disabled='true']):active
    .fui-Option__checkIcon.fui-Option__checkIcon {
    background-color: var(--winui-accent-fill-tertiary);
    border-color: var(--winui-accent-fill-tertiary);
    color: var(--winui-text-on-accent-fill-secondary);
  }

  .fui-Option[aria-checked][aria-disabled='true']
    .fui-Option__checkIcon.fui-Option__checkIcon {
    border-color: var(--winui-control-strong-stroke-disabled);
    color: var(--winui-text-on-accent-fill-disabled);
  }

  .fui-Option[aria-checked='false'][aria-disabled='true']
    .fui-Option__checkIcon.fui-Option__checkIcon {
    background-color: var(--winui-control-alt-fill-disabled);
  }

  .fui-Option[aria-checked='true'][aria-disabled='true']
    .fui-Option__checkIcon.fui-Option__checkIcon {
    background-color: var(--winui-accent-fill-disabled);
  }
}

/* The drop-down's reveal. WinUI does not slide or fade a ComboBox popup: it
   runs SplitOpenThemeAnimation, which holds the popup opaque from the first
   frame and grows a vertical clip out of a band half the list's height. 250ms
   on the fast-out-slow-in spline; the same constants the menu's reveal uses,
   and unrelated to the PopupThemeTransition whose timing ../presence.ts
   declines to guess at, which ComboBox never invokes.

   WinUI's split is centred on the FIELD, not on the popup: it aligns the
   selected item over the faceplate and grows out from there, which is what
   OffsetFromCenter carries. That needs the popup to cover the field, and
   Fluent places it beside -- measured, the field ends at 181 and the list
   begins at 184 -- so the faithful form is not available without moving the
   popup, which is a layout change rather than a motion one. What is left of
   the idea is the direction: the list unfurls from the edge that meets the
   field, away from it. A popup below grows downward, one that flipped above
   grows upward.

   The opacity leg of the split is deliberately not transcribed either, for the
   same reason: WinUI dims the faceplate from 1.0 to 0.5 as the popup covers it,
   so that leg is one half of a crossfade between the field's own text and the
   list. With the popup beside the field there is nothing underneath for it to
   cross-fade with, and dimming the field would only make it look disabled.

   The close is not animated, because Fluent leaves a closed popup with no
   animatable state: the listbox stays mounted for as long as the trigger holds
   focus and is collapsed with display: none, and it is unmounted outright once
   focus leaves. Neither half of that offers an exit to run on.

   Written as an animation rather than a transition because the element enters
   already in its final state, and on clip-path rather than transform because
   transform is where Fluent's positioning lives -- the popup is placed by a
   matrix translate, and a keyframe naming transform would replace it and play
   the reveal at the origin of the containing block.

   Two things about the shape of this rule. The direction is carried by custom
   properties inside ONE set of keyframes rather than by two animation names:
   the placement attribute is written a few milliseconds after the element
   mounts, and swapping animation-name at that point restarts the animation from
   zero, where swapping a custom property leaves it running and simply
   recomputes. And the animation is gated on the attribute existing at all, so
   an unplaced popup does not animate in the default direction and then correct
   itself -- the same gate Radix puts on its own popper content, for the same
   reason.

   32px is headroom over what shadow16 needs -- the derivation is written once,
   at the same constant in ./menu.css.ts. The leading edge nonetheless starts on
   the border box rather than outside it: a clip that opened at -32px would show
   a band of the popup's own shadow before any of the list it belongs to. It
   reaches -32px by the end, so the shadow grows in with the content it is cast
   by.

   The reveal starts from half the list, not from none of it: WinUI's clip opens
   at a scale of ClosedRatio, 0.50, and grows to cover, so half the popup is
   already on screen at the first frame and the animation only finishes it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L517-L528
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/SplitOpenThemeAnimation_Partial.h#L16-L17
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/ThemeAnimations.cpp#L596-L721
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-combobox/library/src/components/Combobox/useCombobox.tsx#L102
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-combobox/library/src/components/Combobox/useComboboxStyles.styles.ts#L93-L94 */
@keyframes floway-combobox-listbox-reveal {
  from {
    clip-path: inset(
      var(--floway-listbox-reveal-leading) -32px var(--floway-listbox-reveal-trailing) -32px);
  }
  to { clip-path: inset(-32px); }
}

.floway-combobox-listbox {
  --floway-listbox-reveal-leading: 0%;
  --floway-listbox-reveal-trailing: 50%;
  animation-duration: var(--winui-control-normal-animation-duration);
  animation-timing-function: var(--winui-control-fast-out-slow-in-easing);
}

.floway-combobox-listbox[data-popper-placement^='top'] {
  --floway-listbox-reveal-leading: 50%;
  --floway-listbox-reveal-trailing: 0%;
}

.floway-combobox-listbox[data-popper-placement] {
  animation-name: floway-combobox-listbox-reveal;
}

/* The reveal grows the popup out of a band, which alters its perceived size, so
   it goes when the OS says motion goes. WinUI reaches the same end by a third
   route, neither of the two the rest of this layer cites: the popup's storyboard
   is a VisualState's own, but SplitOpenThemeAnimation is a DynamicTimeline, and
   with animations disabled the VSM generates it in SteadyState rather than
   Transition mode, which emits the end values and no motion.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/vsm/VisualStateManagerActuator.cpp#L383-L400 */
@media (prefers-reduced-motion: reduce) {
  .floway-combobox-listbox {
    animation-duration: 0.01ms;
  }
}

/* High Contrast. The dictionary collapses every pointer and selection fill in
   the list onto Highlight with a HighlightText foreground, drops a disabled
   item -- selected or not -- to a transparent fill with GrayText, which on the
   drop-down is the surface's own Canvas, and gives the pill the same Highlight
   the row is filled with, so it is the fill that carries selection there rather
   than the bar. The field's disabled stroke is GrayText, which is what Fluent
   already paints under forced colours; it is restated because the disabled rule
   above outranks that atom.

   A media query carries no specificity, so each rule repeats the selector it
   answers.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L110-L127
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L162
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L211
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L2026
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L2058
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L2076-L2080
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
@media (forced-colors: active) {
  .fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:has(.fui-Dropdown__button:disabled),
  .fui-Combobox.fui-Combobox[data-winui-appearance='outline']:has(.fui-Combobox__input:disabled) {
    border-color: GrayText;
  }

  .fui-Option.fui-Option:not([aria-disabled='true']):hover,
  .fui-Option.fui-Option:not([aria-disabled='true']):active,
  .fui-Option.fui-Option[aria-selected='true'],
  .fui-Option.fui-Option[aria-checked='true'] {
    background-color: Highlight;
    color: HighlightText;
  }

  .fui-Option.fui-Option[aria-disabled='true'] {
    background-color: Canvas;
    color: GrayText;
  }

  .fui-Option.fui-Option[aria-selected='true']::before {
    background-color: Highlight;
  }
}
`;
