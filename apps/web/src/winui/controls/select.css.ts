// WinUI 3 ComboBox styling for Fluent v9's Dropdown, Combobox, Listbox and
// Option. Only `[data-winui-appearance='outline']` is addressed -- Fluent's
// underline, filled-lighter and filled-darker fields have no WinUI
// counterpart and are left as Fluent draws them. The Dropdown button's root
// and the Combobox root share border and fill, so they are addressed as one
// selector list throughout.
//
// Windows High Contrast is transcribed for the drop-down list at the end of
// this sheet because Fluent states no option table there; the multiselect
// check box keeps Fluent's forced-colours drawing for the reason
// ./choice.css.ts writes down for every check box.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L110-L136
export const selectCss = `
/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L32 */
.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline'],
.fui-Combobox.fui-Combobox[data-winui-appearance='outline'] {
  background-color: var(--winui-control-fill-default);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L54 */
.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:not(:has(.fui-Dropdown__button[aria-invalid='true'])),
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']:not(:has(.fui-Combobox__input[aria-invalid='true'])) {
  border-color: var(--winui-control-elevation-border-color);
}

/* The pressed and disabled placeholder steps must be stated because the rest
   rule outweighs Fluent's own pressed value and its disabled atom.
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
   the elevation stroke alone; Fluent does the opposite.

   The pointer never leaves WinUI's Disabled visual state, and the wrapper this
   sheet paints stays enabled while the inner control carries the disabled
   attribute, so every state below excludes the disabled field itself. Leaving
   that to the disabled rule further down does not hold: the disabled field is
   named through :has, and a state written beside another :has -- the invalid
   exclusions here -- reaches the same weight plus its pseudo-class and wins.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L33
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L55 */
.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:hover:not(:has(.fui-Dropdown__button:disabled)),
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']:hover:not(:has(.fui-Combobox__input:disabled)) {
  background-color: var(--winui-control-fill-secondary);
}

.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:hover:not(:has(.fui-Dropdown__button:disabled)):not(:has(.fui-Dropdown__button[aria-invalid='true'])),
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']:hover:not(:has(.fui-Combobox__input:disabled)):not(:has(.fui-Combobox__input[aria-invalid='true'])) {
  border-color: var(--winui-control-elevation-border-color);
}

/* Keyboard focus. WinUI lights a detached highlight border inset by -4px plus
   the accent pill on the faceplate's leading edge. An outline at 2px offset
   reproduces that border -- the ring is carried by an outline rather than by
   the ::after this appearance frees below -- except at the corner, where an
   outline takes the field's radius plus its offset and so lands a pixel tighter
   than WinUI's fixed 7px. The shadow fills the two offset pixels with
   HighlightBackground, which coincides with the stroke in light and parts from
   it in dark.
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

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L324
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

/* Fluent's brand underline is the affordance the ring above replaces, so the
   pseudo-element drawing it is dropped on the appearance WinUI paints. */
.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']::after,
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']::after {
  content: none;
}

/* Fluent swaps the field border to its pressed stroke while focus is inside, where
   WinUI's Focused state leaves it, so the rest stroke is restated. Fluent's own
   invalid border is written against :not(:focus-within), so no invalid exclusion.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L473-L487 */
.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:focus-within,
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']:focus-within {
  border-color: var(--winui-control-elevation-border-color);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L34
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L56 */
.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:active:not(:has(.fui-Dropdown__button:disabled)),
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']:active:not(:has(.fui-Combobox__input:disabled)),
.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:has(.fui-Dropdown__button[aria-expanded='true']),
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']:has(.fui-Combobox__input[aria-expanded='true']) {
  background-color: var(--winui-control-fill-tertiary);
}

.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:active:not(:has(.fui-Dropdown__button:disabled)):not(:has(.fui-Dropdown__button[aria-invalid='true'])),
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']:active:not(:has(.fui-Combobox__input:disabled)):not(:has(.fui-Combobox__input[aria-invalid='true'])),
.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:has(.fui-Dropdown__button[aria-expanded='true']),
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']:has(.fui-Combobox__input[aria-expanded='true']) {
  border-color: var(--winui-control-stroke-default);
}

/* WinUI dims an open ComboBox's label whatever the field looks like, so this is not
   tied to an appearance. A disabled field can still take :active on the root -- the
   pointer event lands on the wrapper -- so the enabled guard keeps Fluent's disabled
   text fill.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L42
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L43 */
.fui-Dropdown:active .fui-Dropdown__button.fui-Dropdown__button:enabled,
.fui-Combobox:active .fui-Combobox__input.fui-Combobox__input:enabled,
.fui-Dropdown__button.fui-Dropdown__button:enabled[aria-expanded='true'],
.fui-Combobox__input.fui-Combobox__input:enabled[aria-expanded='true'] {
  color: var(--winui-text-fill-secondary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L35
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L57 */
.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:has(.fui-Dropdown__button:disabled),
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']:has(.fui-Combobox__input:disabled) {
  background-color: var(--winui-control-fill-disabled);
  border-color: var(--winui-control-stroke-default);
}

/* The glyph rule below outweighs Fluent's disabled icon colour, so the disabled fill
   is restated; the labels already resolve to it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L59 */
.fui-Dropdown:has(.fui-Dropdown__button:disabled) .fui-Dropdown__expandIcon.fui-Dropdown__expandIcon,
.fui-Dropdown:has(.fui-Dropdown__button:disabled) .fui-Dropdown__clearButton.fui-Dropdown__clearButton,
.fui-Combobox:has(.fui-Combobox__input:disabled) .fui-Combobox__expandIcon.fui-Combobox__expandIcon,
.fui-Combobox:has(.fui-Combobox__input:disabled) .fui-Combobox__clearIcon.fui-Combobox__clearIcon {
  color: var(--winui-text-fill-disabled);
}

/* The drop-down glyph, which WinUI fixes at 12px rather than scaling with the
   field size.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L58
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L582 */
.fui-Dropdown__expandIcon.fui-Dropdown__expandIcon,
.fui-Combobox__expandIcon.fui-Combobox__expandIcon {
  color: var(--winui-text-fill-secondary);
  font-size: 12px;
  height: 12px;
  width: 12px;
}

/* The clear affordance is Fluent's own -- WinUI's ComboBox has none -- but it sits in
   the glyph's place, so it takes the colour WinUI gives the buttons inside a text
   control.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L45
   https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-combobox/library/src/components/Dropdown/useDropdown.tsx#L98-L113 */
.fui-Dropdown__clearButton.fui-Dropdown__clearButton,
.fui-Combobox__clearIcon.fui-Combobox__clearIcon {
  color: var(--winui-text-fill-secondary);
}

/* WinUI states the leading inset twice -- 12px for the read-only presenter,
   11px for the editable TextBox -- so Dropdown and Combobox each take their own
   number. WinUI's trailing 38px belongs to a TextBox spanning both template
   columns; Fluent gives the input a column of its own, so the glyph's margin
   carries the whole trailing inset and the icon's hit-area extension is
   re-anchored to it.
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

/* The drop-down surface. AcrylicInAppFillColorDefaultBrush is taken as the flat
   FallbackColor it declares for itself, because the flyout surfaces in this
   layer do no backdrop compositing.
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

/* Fluent's public render slot inserts this viewport into the positioned Listbox
   so OverlayScrollbars can own the scrolling surface without reparenting the
   Options or moving the ARIA and active-descendant root. Floating UI writes a
   constrained height to the outer root; flex propagates it here, while
   max-height keeps the unconstrained content path intrinsic.
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

/* List items. The radius is ComboBoxItemCornerRadius, stated for this item alone
   rather than as a step of the shared radius pair; the padding is asymmetric so
   the label sits optically centred against the taller bottom inset.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L345
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L335
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L345 */
.fui-Option.fui-Option {
  border-radius: 3px;
  padding-block: 5px 7px;
  padding-inline: 11px;
}

/* Item states run on the subtle-fill ramp. A disabled item runs neither state,
   and Fluent agrees by withholding its interactive atom, so the guard keeps
   these rules from outranking it.
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

/* Selection. WinUI keeps a standing subtle wash and inverts the interaction pair
   against it, so a selected item goes one step lighter on hover where an
   unselected item goes one step darker. A multiselect listbox reports its
   options as menuitemcheckbox rather than option, so each rule takes the checked
   state alongside the selected one.
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

/* The accent selection pill, drawn as ::before because Fluent spends ::after on
   the active-descendant focus ring. A multiselect option gets no pill: WinUI's
   ComboBox has no multiselect form, and Fluent's checkbox there already reads
   the state. WinUI fixes the pill at 16px on its 32px item; a quarter inset at
   each end reproduces that exactly while keeping it in proportion when an Option
   carries multi-line content.
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

/* Pressing a selected item shortens its pill to ComboBoxItemPillMinScale. The
   timing rides the pressed rule rather than the pill's own, because WinUI
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

/* The pill is WinUI's whole single-select indicator, so Fluent's check glyph
   goes -- and so does the column it sat in, since WinUI draws the pill inside
   the item's own padding rather than beside it and keeping the glyph's space
   would indent every label past where the template puts it. The rule is scoped
   to the option role a single-select listbox writes, so a multiselect option
   keeps its checkbox.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L759
   https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-combobox/library/src/components/Option/useOption.tsx#L115-L117 */
.fui-Option[aria-selected] .fui-Option__checkIcon.fui-Option__checkIcon {
  display: none;
}

/* The check box a multiselect option keeps, on WinUI's own state table. Once
   checked, the stroke IS the accent fill, so the box reads as a filled square
   with no outline.

   Colour is confined to the not-forced-colours query below, for the reason
   ./choice.css.ts writes down for every check box: an accent-filled indicator
   under forced colours also needs forced-color-adjust: none, which this layer
   does not take on. ./choice.css.ts states the same table for the check box
   control; an option draws its box from a different slot, so it is restated
   here rather than inherited.
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

/* The drop-down's reveal. WinUI runs SplitOpenThemeAnimation, which holds the
   popup opaque from the first frame and grows a vertical clip out of a band
   half the list's height -- ClosedRatio is 0.50, so half the popup is already
   on screen at the first frame and the animation only finishes it.

   Two legs of the split are deliberately not transcribed. WinUI centres it on
   the FIELD, aligning the selected item over the faceplate and growing out from
   there; Fluent places the popup beside the field instead, so the faithful form
   would need a layout change rather than a motion one. What is left of the idea
   is the direction: the list unfurls from the edge that meets the field, away
   from it. The opacity leg goes for the same reason -- it is half a cross-fade
   with the faceplate underneath, and with the popup beside the field dimming it
   would only make it look disabled.

   The close is not animated, because Fluent leaves a closed popup with no
   animatable state: the listbox is collapsed with display: none while the
   trigger holds focus, and unmounted outright once focus leaves.

   Written as an animation rather than a transition because the element enters
   already in its final state, and on clip-path rather than transform because
   transform is where Fluent's positioning lives -- the popup is placed by a
   matrix translate, and a keyframe naming transform would replace it and play
   the reveal at the origin of the containing block.

   The direction is carried by custom properties inside ONE set of keyframes
   rather than by two animation names: the placement attribute is written a few
   milliseconds after the element mounts, and swapping animation-name at that
   point restarts the animation from zero, where swapping a custom property
   leaves it running and simply recomputes. The animation is gated on the
   attribute existing at all, so an unplaced popup does not animate in the
   default direction and then correct itself -- the same gate Radix puts on its
   own popper content.

   32px is headroom over what shadow16 needs; the derivation is written once, at
   the same constant in ./menu.css.ts. The leading edge nonetheless starts on
   the border box rather than outside it: a clip that opened at -32px would show
   a band of the popup's own shadow before any of the list it belongs to.
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
   it goes when the OS says motion goes. WinUI reaches the same end by a route
   of its own: SplitOpenThemeAnimation is a DynamicTimeline, and with animations
   disabled the VSM generates it in SteadyState rather than Transition mode,
   which emits the end values and no motion.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/components/vsm/VisualStateManagerActuator.cpp#L383-L400 */
@media (prefers-reduced-motion: reduce) {
  .floway-combobox-listbox {
    animation-duration: 0.01ms;
  }
}

/* High Contrast. The pill takes the same Highlight the row is filled with, so
   it is the fill that carries selection there rather than the bar. The field's
   disabled stroke is what Fluent already paints under forced colours; it is
   restated because the disabled rule above outranks that atom.

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
