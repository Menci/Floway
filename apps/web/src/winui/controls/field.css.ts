// Field, InfoLabel and Link restyled to the WinUI 3 look.
//
// None of the three has a WinUI counterpart control. A Field is the
// HeaderContentPresenter of a WinUI text control plus its DescriptionPresenter
// line, and a Link is the accent text fill a HyperlinkButton paints; the rules
// below take their values from those roles.
//
// The accent text ramp a Link walks resolves to steps Windows derives from the
// user's accent colour, which appear in no theme dictionary as a literal.
// ../tokens.ts transcribes the ramp Windows generates for its own default, at
// the cost of that one assumption.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L297

// Fluent's only DOM marker for a Field's horizontal orientation is the hashed
// atom Griffel emits for `useRootStyles.horizontal`. The name is a content hash
// of the declaration, so it is pinned to the version this app resolves — in
// @fluentui/react-field 9.5.3, `grid-template-rows: auto auto auto 1fr` — and
// exported so a suite can render a horizontal Field and fail the moment a
// Fluent bump rehashes it.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-field/library/src/components/Field/useFieldStyles.styles.ts#L29-L32
export const fieldHorizontalRootAtom = 'f1645dqt';

// The success validation state marks nothing on the Field root or the message:
// its only DOM trace is the Griffel atom Fluent puts on the message glyph for
// the success colour. In @fluentui/react-field 9.5.3 this atom is
// `color: var(--colorPaletteGreenForeground1)`.
//
// It is the more fragile of the two pins and the only one no suite renders: a
// Griffel atom hashes property and value together, so it rehashes on a rename of
// the palette token as well as on a change of colour, and when it does the rule
// below silently stops matching.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-field/library/src/components/Field/useFieldStyles.styles.ts#L117-L119
export const fieldSuccessIconAtom = 'ffmvakt';

export const fieldCss = `
/* Auto-sized Field tracks otherwise share surplus height when a parent grid
   stretches the Field to match a taller sibling. Keep the header and control
   at their intrinsic sizes so mixed controls retain the same 8px header gap. */
.fui-Field.fui-Field:not(.${fieldHorizontalRootAtom}) {
  align-content: start;
}

/* WinUI gives a text control's header no vertical padding and separates it from
   the control by a flat 8px, where Fluent scales padding and margin with the
   field size. Fluent's horizontal orientation is a layout WinUI has no header
   for, and there the label's vertical padding is what aligns it with the
   control's first text line, so the horizontal root atom is negated to keep this
   rule off it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L175
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L335 */
.fui-Field:not(.${fieldHorizontalRootAtom}) > .fui-Field__label.fui-Field__label {
  padding-block: 0;
  margin-bottom: 8px;
}

/* WinUI paints a control's description line with
   SystemControlDescriptionTextForegroundBrush, a step of its own distinct from
   the secondary text fill, which ../tokens.ts carries as --winui-text-base-medium.
   The description presenter also inherits the text control's own 14px FontSize,
   where Fluent's secondary text is the 12px caption ramp. Hint and validation
   message share one neutral base atom, so the colour is written as a
   redefinition of that token on both slots.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L340
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L186
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L36 */
.fui-Field__hint.fui-Field__hint,
.fui-Field__validationMessage.fui-Field__validationMessage {
  --colorNeutralForeground3: var(--winui-text-base-medium);
  font-size: var(--fontSizeBase300);
  line-height: var(--lineHeightBase300);
}

/* The glyph Fluent sets beside a validation message. WinUI gives a text field
   no validation vocabulary at all, so Fluent's three states are kept and
   re-expressed below in WinUI's SystemFill roles. The glyph goes because the one
   slot WinUI does give a field for subordinate text, Description, is a bare
   ContentPresenter with a foreground and no icon column.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L340 */
.fui-Field__validationMessageIcon.fui-Field__validationMessageIcon {
  display: none;
}

/* Fluent indents the message by the column the glyph sat in, so removing the
   glyph alone leaves the words hanging off the field's leading edge. */
.fui-Field__validationMessage.fui-Field__validationMessage {
  padding-inline-start: 0;
}

/* An invalid control is the one validation state Fluent states in the DOM
   rather than in a Griffel atom: the Field pushes aria-invalid onto the control
   it wraps, which lets the message be addressed from the root. WinUI's
   counterpart is SystemFillColorCritical.

   None of the three message colours below states a forced-colors answer, because
   WinUI has none to transcribe: its HighContrast dictionary poisons every
   SystemFill colour to #FF0000 so that a control still reading one there shows
   up as a defect.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L282
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L78
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L578-L580
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
.fui-Field:has([aria-invalid='true']) .fui-Field__validationMessage.fui-Field__validationMessage {
  color: var(--winui-system-fill-critical);
}

/* The warning state announces itself through role="alert" on the message
   (useFieldBase.js), which the error state also sets -- so this rule matches
   both and the error rule above, one attribute more specific, takes the fields
   that are actually invalid. WinUI's counterpart is SystemFillColorCaution.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L281
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L77 */
.fui-Field__validationMessage.fui-Field__validationMessage[role='alert'] {
  color: var(--winui-system-fill-caution);
}

/* Success writes neither aria-invalid nor role, so it is addressed through the
   pinned glyph atom -- the glyph is hidden, not removed, and still answers a
   selector. Fluent leaves the words themselves on the neutral secondary colour
   and says success in the icon alone, which this sheet has taken away, so the
   state is carried by the message instead. WinUI's counterpart is
   SystemFillColorSuccess.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L280
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L76 */
.fui-Field__validationMessage.fui-Field__validationMessage:has(> .fui-Field__validationMessageIcon.${fieldSuccessIconAtom}) {
  color: var(--winui-system-fill-success);
}

/* A link's three enabled steps. WinUI walks a HyperlinkButton down the accent
   TEXT ramp, which is a different ramp from the accent FILL an accent button
   takes: it is darkened in light and lightened in dark so it stays legible as
   type rather than as a surface. Scoped to the default appearance, like the
   disabled step below, because Fluent's subtle link is neutral by design.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/HyperlinkButton_themeresources.xaml#L5-L7
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L297-L299
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L93-L95 */
.fui-Link.fui-Link[data-winui-appearance='default']:not([aria-disabled='true']) {
  color: var(--winui-accent-text-fill-primary);
}

.fui-Link.fui-Link[data-winui-appearance='default']:not([aria-disabled='true']):hover {
  color: var(--winui-accent-text-fill-secondary);
}

.fui-Link.fui-Link[data-winui-appearance='default']:not([aria-disabled='true']):active {
  color: var(--winui-accent-text-fill-tertiary);
}

/* A focused link. WinUI gives a HyperlinkButton two concentric rings pushed 3px
   outside the control, which an inline link cannot carry -- the element wraps
   across lines and the rings would break with it -- so Fluent's doubled
   underline stays and only its stroke takes WinUI's outer focus colour. Every
   appearance shares one focus visual in both systems, so this one is not scoped
   to an appearance.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/HyperlinkButton_themeresources.xaml#L62-L63
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258 */
.fui-Link.fui-Link[data-fui-focus-visible] {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
}

/* A disabled link. AccentTextFillColorDisabled is the one member of the accent
   text ramp the dictionaries state as a literal, and it carries the same value
   as TextFillColorDisabled -- a neutral fade that happens to arrive through the
   accent ramp, and a different neutral from Fluent's own. WinUI has no
   subtle-hyperlink counterpart, so the subtle appearance is deliberately left
   wholly on Fluent's ramp. Fluent repeats its disabled colour under :hover and
   :active, so the override repeats there.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/HyperlinkButton_themeresources.xaml#L8
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L212-L214
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L8-L10 */
.fui-Link.fui-Link[data-winui-appearance='default'][aria-disabled='true'],
.fui-Link.fui-Link[data-winui-appearance='default'][aria-disabled='true']:hover,
.fui-Link.fui-Link[data-winui-appearance='default'][aria-disabled='true']:active {
  color: var(--winui-accent-text-fill-disabled);
}

/* WinUI's HighContrast dictionary takes the hyperlink off the accent ramp and
   names a system colour for each of its four steps, which CSS spells LinkText,
   CanvasText, Highlight and GrayText.

   A system-colour keyword is the one author colour forced colours honour, so the
   accent ramp above goes inert there on its own -- but what the user agent
   substitutes depends on the element, and Fluent renders a Link without an href
   as a <button>, which would take ButtonText rather than the hyperlink colour.
   Naming all four steps keeps both element forms on WinUI's answer. A media
   query adds no specificity, so each selector here repeats the one it
   overrides.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/HyperlinkButton_themeresources.xaml#L34-L38
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L2083
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L2097
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L2073
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L2026
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
@media (forced-colors: active) {
  .fui-Link.fui-Link[data-winui-appearance='default']:not([aria-disabled='true']) {
    color: LinkText;
  }

  .fui-Link.fui-Link[data-winui-appearance='default']:not([aria-disabled='true']):hover {
    color: CanvasText;
  }

  .fui-Link.fui-Link[data-winui-appearance='default']:not([aria-disabled='true']):active {
    color: Highlight;
  }

  .fui-Link.fui-Link[data-winui-appearance='default'][aria-disabled='true'],
  .fui-Link.fui-Link[data-winui-appearance='default'][aria-disabled='true']:hover,
  .fui-Link.fui-Link[data-winui-appearance='default'][aria-disabled='true']:active {
    color: GrayText;
  }
}
`;
