// WinUI 3 ComboBox styling for Fluent v9's Dropdown, Combobox, Listbox and
// Option. Fluent paints these as a Fluent 2 Web field — opaque background,
// uniform neutral outline, brand underline on focus — while WinUI paints a
// translucent control fill inside a directional elevation stroke, lights a
// detached focus ring instead of the underline, and marks the selected list
// item with an accent pill instead of a check glyph alone.
//
// The field rules address `[data-winui-appearance='outline']`, the appearance
// whose Fluent form — opaque fill inside a full outline — is the one WinUI's
// ComboBox has. Fluent's `underline`, `filled-lighter` and `filled-darker`
// fields have no WinUI counterpart and are left as Fluent draws them.
//
// The WinUI ComboBox dictionary declares one key set and resolves it per theme,
// so each rule below is written once against a theme-aware `--winui-*`
// variable rather than duplicated per color scheme.
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

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L48 */
.fui-Combobox__input.fui-Combobox__input::placeholder {
  color: var(--winui-text-fill-secondary);
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

/* Keyboard focus. WinUI does not touch the field: it lights a separate
   highlight border inset by -4px around the control, two pixels of the outer
   focus stroke drawn at its own 7px corner. An outline reproduces it — a 2px
   offset puts the stroke's outer edge at the same 4px out — except for that
   corner, which an outline can only inherit from the field plus the offset and
   so rounds a pixel tighter than WinUI's fixed 7px. Fluent's keyboard-modality
   data attribute keeps pointer focus in the pressed/rest states while still
   finding the button or input inside each root. Fluent's brand underline is
   the affordance this replaces, so the pseudo-element drawing it is dropped on
   the appearance WinUI paints. WinUI's focus visual is two concentric rings:
   the outline supplies the outer one and a shadow spread across the two pixels
   the outline is offset by supplies the inner one, which is where WinUI puts
   it — immediately against the control.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L38
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L338
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L343
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L570
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L473-L476 */
.fui-Dropdown.fui-Dropdown[data-winui-appearance='outline']:has([data-fui-focus-visible]),
.fui-Combobox.fui-Combobox[data-winui-appearance='outline']:has([data-fui-focus-visible]) {
  box-shadow: 0 0 0 2px var(--winui-focus-stroke-inner);
  outline: 2px solid var(--winui-focus-stroke-outer);
  outline-offset: 2px;
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
   an appearance.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L42 */
.fui-Dropdown:active .fui-Dropdown__button.fui-Dropdown__button,
.fui-Combobox:active .fui-Combobox__input.fui-Combobox__input,
.fui-Dropdown__button.fui-Dropdown__button[aria-expanded='true'],
.fui-Combobox__input.fui-Combobox__input[aria-expanded='true'] {
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

/* The clear affordance is Fluent's own — WinUI's ComboBox has no such button —
   but it sits beside the glyph above and takes the colour WinUI gives the
   buttons inside a text control, so the pair reads as one. Its geometry stays
   Fluent's.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L45 */
.fui-Dropdown__clearButton.fui-Dropdown__clearButton,
.fui-Combobox__clearIcon.fui-Combobox__clearIcon {
  color: var(--winui-text-fill-secondary);
}

/* WinUI reads the content inset off the ComboBox padding and the glyph's own
   trailing margin: 12px leading, no trailing padding, and 14px between the
   glyph and the field edge. The Dropdown button reproduces WinUI's grid
   faithfully enough to take the padding; the Combobox splits the inset between
   input and icon, so it keeps Fluent's arithmetic.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L341
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L582 */
.fui-Dropdown__button.fui-Dropdown__button {
  padding-block: 5px 7px;
  padding-inline: 12px 0;
}

.fui-Dropdown__expandIcon.fui-Dropdown__expandIcon {
  margin-inline-end: 14px;
}

/* The drop-down surface. WinUI gives the popup the overlay radius and a real
   flyout stroke, against Fluent's control radius and transparent outline.
   The WinUI fill is AcrylicInAppFillColorDefaultBrush, taken as the flat colour
   that brush declares for itself where there is no acrylic to composite --
   which is every surface on the web, and is why Fluent's flat white was a full
   step brighter than the drop-down WinUI draws.
   BackgroundSizing is InnerBorderEdge, which is background-clip: padding-box on
   the web: the fill stops at the border so the translucent stroke reads against
   whatever the drop-down floats over, as on every other flyout in the layer.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L64
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L332
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L590 */
.fui-Listbox.fui-Listbox,
.fui-Dropdown__listbox.fui-Dropdown__listbox,
.fui-Combobox__listbox.fui-Combobox__listbox {
  background-clip: padding-box;
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

/* List items. WinUI uses a tighter corner — ComboBoxItemCornerRadius, stated
   for this item alone rather than as a step of the shared radius pair — and an
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
   NeutralBackground1Hover/Pressed do. WinUI also dims the label on press.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L16
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L7 */
.fui-Option.fui-Option:hover {
  background-color: var(--winui-subtle-fill-secondary);
  color: var(--winui-text-fill-primary);
}

/* https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L15
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L6 */
.fui-Option.fui-Option:active {
  background-color: var(--winui-subtle-fill-tertiary);
  color: var(--winui-text-fill-secondary);
}

/* Restated for the same reason as the glyphs above: the item-state rules
   further up paint every option, disabled ones included, and would otherwise
   outrank Fluent's own disabled atom.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L8 */
.fui-Option.fui-Option[aria-disabled='true'] {
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
.fui-Option.fui-Option[aria-selected='true'],
.fui-Option.fui-Option[aria-checked='true'] {
  background-color: var(--winui-subtle-fill-secondary);
}

.fui-Option.fui-Option[aria-selected='true']:hover,
.fui-Option.fui-Option[aria-checked='true']:hover {
  background-color: var(--winui-subtle-fill-tertiary);
}

.fui-Option.fui-Option[aria-selected='true']:active,
.fui-Option.fui-Option[aria-checked='true']:active {
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
   than a second reading of the same state. WinUI's standard 32px item carries
   a 16px pill; quarter-block insets preserve that exact geometry and let the
   indicator grow proportionally when an Option has multi-line content.
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

/* The pill is WinUI's whole single-select indicator, so the check glyph Fluent
   shows in the same role goes -- and so does the column it sat in. WinUI's item
   is a label against the item's own padding with the pill drawn inside that
   inset, not beside it, so keeping the glyph's space would indent every label
   in the list past where the template puts it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L759 */
.fui-Option .fui-Option__checkIcon.fui-Option__checkIcon {
  display: none;
}

/* The drop-down's reveal. WinUI does not slide or fade a ComboBox popup: it
   runs SplitOpenThemeAnimation, which holds the popup opaque from the first
   frame and grows a vertical clip out of a band half the popup's height,
   centred on it -- the clip origin is pinned at (0, 0.5) so the two edges
   travel at the same speed. 250ms on the fast-out-slow-in spline; the same
   constants the menu's reveal uses, and unrelated to the PopupThemeTransition
   whose timing ../presence.ts declines to guess at, which ComboBox never
   invokes.

   The opacity leg of the split is deliberately not transcribed. WinUI dims the
   faceplate from 1.0 to 0.5 as the popup opens because the popup covers the
   field, so that leg is one half of a crossfade between the field's own text
   and the list; Fluent places the popup below the field instead -- measured,
   the field ends at 181 and the list starts at 184 -- so there is no text
   underneath for it to cross-fade with, and dimming the field would only make
   it look disabled.

   The close is not animated. Fluent unmounts the listbox when the combo box
   closes, so there is no element left for an exit to run on; a close animation
   needs a wrapper that holds the popup mounted through it.

   Written as an animation rather than a transition because the element enters
   already in its final state, and on clip-path rather than transform because
   transform is where Fluent's positioning lives -- the popup is placed by a
   matrix translate, and a keyframe naming transform would replace it and play
   the reveal at the origin of the containing block.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L517-L528
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/SplitOpenThemeAnimation_Partial.h#L16-L17 */
@keyframes floway-combobox-listbox-reveal {
  from { clip-path: inset(25% 0% 25% 0%); }
  to { clip-path: inset(0% 0% 0% 0%); }
}

.floway-combobox-listbox {
  animation-name: floway-combobox-listbox-reveal;
  animation-duration: var(--winui-control-normal-animation-duration);
  animation-timing-function: var(--winui-control-fast-out-slow-in-easing);
}

/* The reveal grows the popup out of a band, which alters its perceived size, so
   it goes when the OS says motion goes. WinUI reaches the same end differently:
   the storyboard is a Transition, which the VSM seeks to its last frame. */
@media (prefers-reduced-motion: reduce) {
  .floway-combobox-listbox {
    animation-duration: 0.01ms;
  }
}
`;
