// WinUI 3 ComboBox styling for Fluent v9's Select, Dropdown, Combobox, Listbox
// and Option. Fluent paints these as a Fluent 2 Web field — opaque background,
// uniform neutral outline, brand underline on focus — while WinUI paints a
// translucent control fill inside a directional elevation stroke, lights a
// detached focus ring instead of the underline, and marks the selected list
// item with an accent pill instead of a check glyph alone.
//
// Every rule is scoped under `.fui-FluentProvider`, the element that carries
// both Fluent's tokens and the `--winui-*` vocabulary, which puts each selector
// at least one class above Griffel's single-class atoms.
//
// The field rules address `[data-winui-appearance="outline"]`, the appearance
// whose Fluent form — opaque fill inside a full outline — is the one WinUI's
// ComboBox has. Fluent's `underline`, `filled-lighter` and `filled-darker`
// fields have no WinUI counterpart and are left as Fluent draws them.
//
// The WinUI ComboBox dictionary declares one key set and resolves it per theme,
// so each rule below is written once against a theme-aware `--winui-*`
// variable rather than duplicated per color scheme.
//
// The three field shells — the native `<select>`, the Dropdown button's root,
// and the Combobox root — carry the same border and fill in Fluent, so they are
// addressed as one selector list throughout. Where a rule belongs to the box
// around the field rather than the field itself, it addresses the three roots
// instead, the Select's included.
export const selectCss = `
/* Field shell at rest. WinUI fills the ComboBox with a translucent control fill
   over whatever sits behind it, where Fluent paints an opaque neutral.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L32 */
.fui-FluentProvider .fui-Select__select[data-winui-appearance="outline"],
.fui-FluentProvider .fui-Dropdown[data-winui-appearance="outline"],
.fui-FluentProvider .fui-Combobox[data-winui-appearance="outline"] {
  background-color: var(--winui-control-fill-default);
}

/* The rest outline is WinUI's directional elevation stroke rather than a
   uniform neutral plus a darker bottom edge.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L54 */
.fui-FluentProvider .fui-Select__select[data-winui-appearance="outline"]:not([aria-invalid="true"]),
.fui-FluentProvider .fui-Dropdown[data-winui-appearance="outline"]:not(:has(.fui-Dropdown__button[aria-invalid="true"])),
.fui-FluentProvider .fui-Combobox[data-winui-appearance="outline"]:not(:has(.fui-Combobox__input[aria-invalid="true"])) {
  border-color: var(--winui-control-elevation-border-color);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L48 */
.fui-FluentProvider .fui-Combobox__input::placeholder {
  color: var(--winui-text-fill-secondary);
}

/* Hover. WinUI moves the fill one step down the control-fill ramp and leaves
   the elevation stroke alone; Fluent does the opposite, holding the fill and
   brightening the outline.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L33
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L55 */
.fui-FluentProvider .fui-Select__select[data-winui-appearance="outline"]:enabled:hover,
.fui-FluentProvider .fui-Dropdown[data-winui-appearance="outline"]:hover,
.fui-FluentProvider .fui-Combobox[data-winui-appearance="outline"]:hover {
  background-color: var(--winui-control-fill-secondary);
}

.fui-FluentProvider .fui-Select__select[data-winui-appearance="outline"]:enabled:hover:not([aria-invalid="true"]),
.fui-FluentProvider .fui-Dropdown[data-winui-appearance="outline"]:hover:not(:has(.fui-Dropdown__button[aria-invalid="true"])),
.fui-FluentProvider .fui-Combobox[data-winui-appearance="outline"]:hover:not(:has(.fui-Combobox__input[aria-invalid="true"])) {
  border-color: var(--winui-control-elevation-border-color);
}

/* Focus. WinUI does not touch the field: it lights a separate highlight border
   inset by -4px around the control, two pixels of the outer focus stroke drawn
   at its own 7px corner. An outline reproduces it — a 2px offset puts the
   stroke's outer edge at the same 4px out — except for that corner, which an
   outline can only inherit from the field plus the offset and so rounds a pixel
   tighter than WinUI's fixed 7px. Fluent's brand underline is the affordance
   this replaces, so the pseudo-element drawing it is dropped on the appearance
   WinUI paints.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L38
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L338
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L343
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L570
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L473-L476 */
.fui-FluentProvider .fui-Select[data-winui-appearance="outline"]:focus-within,
.fui-FluentProvider .fui-Dropdown[data-winui-appearance="outline"]:focus-within,
.fui-FluentProvider .fui-Combobox[data-winui-appearance="outline"]:focus-within {
  outline: 2px solid var(--winui-focus-stroke-outer);
  outline-offset: 2px;
}

.fui-FluentProvider .fui-Select[data-winui-appearance="outline"]::after,
.fui-FluentProvider .fui-Dropdown[data-winui-appearance="outline"]::after,
.fui-FluentProvider .fui-Combobox[data-winui-appearance="outline"]::after {
  content: none;
}

/* Fluent also swaps the field border to its pressed stroke while focus is
   inside, where WinUI's Focused state leaves the border brush untouched, so the
   rest stroke is restated against it. No invalid exclusion is needed: Fluent's
   own invalid border is written against :not(:focus-within). The Select needs
   no rule of its own — Fluent changes its field border on hover and press only.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L473-L487 */
.fui-FluentProvider .fui-Dropdown[data-winui-appearance="outline"]:focus-within,
.fui-FluentProvider .fui-Combobox[data-winui-appearance="outline"]:focus-within {
  border-color: var(--winui-control-elevation-border-color);
}

/* Pressed, which for a ComboBox is also the open state: WinUI drops to the
   tertiary fill, flattens the elevation stroke to a uniform default stroke, and
   dims the text one step.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L34
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L56 */
.fui-FluentProvider .fui-Select__select[data-winui-appearance="outline"]:enabled:active,
.fui-FluentProvider .fui-Dropdown[data-winui-appearance="outline"]:active,
.fui-FluentProvider .fui-Combobox[data-winui-appearance="outline"]:active,
.fui-FluentProvider .fui-Dropdown[data-winui-appearance="outline"]:has(.fui-Dropdown__button[aria-expanded="true"]),
.fui-FluentProvider .fui-Combobox[data-winui-appearance="outline"]:has(.fui-Combobox__input[aria-expanded="true"]) {
  background-color: var(--winui-control-fill-tertiary);
}

.fui-FluentProvider .fui-Select__select[data-winui-appearance="outline"]:enabled:active:not([aria-invalid="true"]),
.fui-FluentProvider .fui-Dropdown[data-winui-appearance="outline"]:active:not(:has(.fui-Dropdown__button[aria-invalid="true"])),
.fui-FluentProvider .fui-Combobox[data-winui-appearance="outline"]:active:not(:has(.fui-Combobox__input[aria-invalid="true"])),
.fui-FluentProvider .fui-Dropdown[data-winui-appearance="outline"]:has(.fui-Dropdown__button[aria-expanded="true"]),
.fui-FluentProvider .fui-Combobox[data-winui-appearance="outline"]:has(.fui-Combobox__input[aria-expanded="true"]) {
  border-color: var(--winui-control-stroke-default);
}

/* An open ComboBox is in the same pressed state, so its label dims with the
   fill. WinUI dims it whatever the field looks like, so this one is not tied to
   an appearance.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L42 */
.fui-FluentProvider .fui-Select__select:enabled:active,
.fui-FluentProvider .fui-Dropdown:active .fui-Dropdown__button,
.fui-FluentProvider .fui-Combobox:active .fui-Combobox__input,
.fui-FluentProvider .fui-Dropdown__button[aria-expanded="true"],
.fui-FluentProvider .fui-Combobox__input[aria-expanded="true"] {
  color: var(--winui-text-fill-secondary);
}

/* Disabled. WinUI keeps a visible fill and the ordinary default stroke rather
   than going transparent behind a lightened outline the way Fluent does.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L35
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L57 */
.fui-FluentProvider .fui-Select__select[data-winui-appearance="outline"]:disabled,
.fui-FluentProvider .fui-Dropdown[data-winui-appearance="outline"]:has(.fui-Dropdown__button:disabled),
.fui-FluentProvider .fui-Combobox[data-winui-appearance="outline"]:has(.fui-Combobox__input:disabled) {
  background-color: var(--winui-control-fill-disabled);
  border-color: var(--winui-control-stroke-default);
}

/* The glyphs need the disabled text fill restated because the glyph rule below
   outweighs Fluent's own disabled icon colour; the labels do not, since Fluent
   already paints them with the token this theme maps onto that same fill.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L59 */
.fui-FluentProvider .fui-Select__select:disabled ~ .fui-Select__icon,
.fui-FluentProvider .fui-Dropdown:has(.fui-Dropdown__button:disabled) .fui-Dropdown__expandIcon,
.fui-FluentProvider .fui-Dropdown:has(.fui-Dropdown__button:disabled) .fui-Dropdown__clearButton,
.fui-FluentProvider .fui-Combobox:has(.fui-Combobox__input:disabled) .fui-Combobox__expandIcon,
.fui-FluentProvider .fui-Combobox:has(.fui-Combobox__input:disabled) .fui-Combobox__clearIcon {
  color: var(--winui-text-fill-disabled);
}

/* The drop-down glyph. WinUI fixes it at 12px in the secondary text fill,
   where Fluent scales it with the field size and paints it in the accessible
   stroke colour.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L58
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L582 */
.fui-FluentProvider .fui-Select__icon,
.fui-FluentProvider .fui-Dropdown__expandIcon,
.fui-FluentProvider .fui-Combobox__expandIcon {
  color: var(--winui-text-fill-secondary);
  font-size: 12px;
  height: 12px;
  width: 12px;
}

/* The clear affordance is Fluent's own — WinUI's ComboBox has no such button —
   but it sits beside the glyph above and takes the colour WinUI gives the
   buttons inside a text control, so the pair reads as one. Its geometry stays
   Fluent's.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L45 */
.fui-FluentProvider .fui-Dropdown__clearButton,
.fui-FluentProvider .fui-Combobox__clearIcon {
  color: var(--winui-text-fill-secondary);
}

/* WinUI reads the content inset off the ComboBox padding and the glyph's own
   trailing margin: 12px leading, no trailing padding, and 14px between the
   glyph and the field edge. Only the Dropdown button reproduces WinUI's grid
   faithfully enough to take the padding — the Select's glyph is absolutely
   positioned and the Combobox splits the inset between input and icon, so both
   keep Fluent's arithmetic.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L341
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L582 */
.fui-FluentProvider .fui-Dropdown__button {
  padding-block: 5px 7px;
  padding-inline: 12px 0;
}

.fui-FluentProvider .fui-Dropdown__expandIcon {
  margin-inline-end: 14px;
}

/* The Select's own trailing inset is Fluent's, computed from a 20px icon; the
   glyph shrunk to WinUI's 12px must therefore move out to the same 14px edge
   distance, which leaves the 12px between text and glyph that WinUI's editable
   ComboBox reserves (38px of text padding against a glyph ending at 26px).
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L342
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L582 */
.fui-FluentProvider .fui-Select__icon {
  inset-inline-end: 14px;
}

/* The drop-down surface. WinUI gives the popup the overlay radius and a real
   flyout stroke, against Fluent's control radius and transparent outline.
   The WinUI fill is AcrylicInAppFillColorDefaultBrush, which the token
   vocabulary does not carry, so the surface keeps Fluent's neutral background.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L64
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L332
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L590 */
.fui-FluentProvider .fui-Listbox,
.fui-FluentProvider .fui-Dropdown__listbox,
.fui-FluentProvider .fui-Combobox__listbox {
  border-radius: var(--winui-overlay-corner-radius);
  outline: 1px solid var(--winui-surface-stroke-flyout);
}

/* List items. WinUI uses a tighter corner and an asymmetric padding that sits
   the label optically centred against the taller bottom inset.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L335
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L345 */
.fui-FluentProvider .fui-Option {
  border-radius: 3px;
  padding-block: 5px 7px;
  padding-inline: 11px;
}

/* Item states run on the subtle-fill ramp, which washes over the drop-down
   surface rather than replacing it with a neutral background the way Fluent's
   NeutralBackground1Hover/Pressed do. WinUI also dims the label on press.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L16
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L7 */
.fui-FluentProvider .fui-Option:hover {
  background-color: var(--winui-subtle-fill-secondary);
  color: var(--winui-text-fill-primary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L15
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L6 */
.fui-FluentProvider .fui-Option:active {
  background-color: var(--winui-subtle-fill-tertiary);
  color: var(--winui-text-fill-secondary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L8 */
.fui-FluentProvider .fui-Option[aria-disabled="true"] {
  color: var(--winui-text-fill-disabled);
}

/* Selection. Fluent leaves the selected item visually identical to the rest and
   lets the check glyph carry the state; WinUI keeps a standing subtle wash and
   inverts the interaction pair against it, so a selected item goes one step
   lighter on hover where an unselected item goes one step darker. A multiselect
   listbox reports its options as menuitemcheckbox rather than option, so each
   rule takes the checked state alongside the selected one.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L18
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L20
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L21 */
.fui-FluentProvider .fui-Option[aria-selected="true"],
.fui-FluentProvider .fui-Option[aria-checked="true"] {
  background-color: var(--winui-subtle-fill-secondary);
}

.fui-FluentProvider .fui-Option[aria-selected="true"]:hover,
.fui-FluentProvider .fui-Option[aria-checked="true"]:hover {
  background-color: var(--winui-subtle-fill-tertiary);
}

.fui-FluentProvider .fui-Option[aria-selected="true"]:active,
.fui-FluentProvider .fui-Option[aria-checked="true"]:active {
  background-color: var(--winui-subtle-fill-secondary);
}

/* The accent selection pill on the item's leading edge. WinUI draws it as a
   Rectangle in the template's first grid column; here it is the item's own
   ::before, which is free because Fluent spends ::after on the
   active-descendant focus ring. Since the pill is WinUI's whole single-select
   indicator, the check glyph Fluent shows in the same role is hidden with it —
   the space it occupies is kept so labels stay aligned down the list. A
   multiselect option is left alone in both respects: WinUI's ComboBox has no
   multiselect form, and Fluent's checkbox there is a control of its own rather
   than a second reading of the same state.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L106
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L324
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L325
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L346
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L759 */
.fui-FluentProvider .fui-Option[aria-selected="true"]::before {
  background-color: var(--winui-accent-fill-default);
  border-radius: 1.5px;
  content: "";
  height: 16px;
  inset-block-start: calc(50% - 8px);
  inset-inline-start: 0;
  pointer-events: none;
  position: absolute;
  width: 3px;
}

.fui-FluentProvider .fui-Option[aria-selected="true"] .fui-Option__checkIcon {
  visibility: hidden;
}
`;
