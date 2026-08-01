// Field, InfoLabel and Link restyled to the WinUI 3 look.
//
// None of the three has a WinUI counterpart control. A Field is the
// HeaderContentPresenter of a WinUI text control plus its DescriptionPresenter
// line, and a Link is the accent text fill a HyperlinkButton or an inline
// Hyperlink paints; the rules below take their values from those roles.
// InfoLabel contributes only layout plumbing and needs nothing.
//
// The accent text ramp a Link walks -- AccentTextFillColorPrimary, Secondary
// and Tertiary -- resolves to steps of the ramp Windows derives from the user's
// accent colour, which appear in no theme dictionary as a literal. ../tokens.ts
// transcribes the ramp Windows generates for its own default and the Link rules
// below spend it, at the cost that one assumption.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L297

// Fluent's only DOM marker for a Field's horizontal orientation is the hashed
// atom Griffel emits for `useRootStyles.horizontal`, which no other variant
// overrides. The name is a content hash of the declaration, so it is pinned to
// the version this app resolves — in @fluentui/react-field 9.5.3 this atom is
// `grid-template-rows: auto auto auto 1fr` — and exported so a suite can render
// a horizontal Field and fail the moment a Fluent bump rehashes it.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-field/library/src/components/Field/useFieldStyles.styles.ts#L29-L32
export const fieldHorizontalRootAtom = 'f1645dqt';

export const fieldCss = `
/* Auto-sized Field tracks otherwise share surplus height when a parent grid
   stretches the Field to match a taller sibling. Keep the header and control
   at their intrinsic sizes so mixed controls retain the same 8px header gap. */
.fui-Field.fui-Field:not(.${fieldHorizontalRootAtom}) {
  align-content: start;
}

/* WinUI gives a text control's header no vertical padding and separates it
   from the control by a flat 8px, where Fluent uses 2px of padding on each
   side plus a 2px margin and then rescales all three with the field size. The
   fixed margin also covers Fluent's large-size ramp, which WinUI has no
   equivalent of. Fluent's horizontal orientation is a layout WinUI has no
   header for, and there the label's vertical padding is what aligns it with
   the control's first text line, so the horizontal root atom is negated to
   keep this rule off it.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L175
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L335 */
.fui-Field:not(.${fieldHorizontalRootAtom}) > .fui-Field__label.fui-Field__label {
  padding-block: 0;
  margin-bottom: 8px;
}

/* WinUI paints a control's description line with
   SystemControlDescriptionTextForegroundBrush, which the dictionaries
   reference but never declare, so the nearest declared role for subordinate
   text inside a text control stands in for it: the placeholder foreground,
   which resolves to TextFillColorSecondaryBrush. Fluent's caption metrics
   already match WinUI's CaptionTextBlockStyle. Hint and validation message
   share one neutral base atom, so the substitution is written as a
   redefinition of that token on both slots; the validation states below paint
   over it where they apply.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L340
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L142 */
.fui-Field__hint.fui-Field__hint,
.fui-Field__validationMessage.fui-Field__validationMessage {
  --colorNeutralForeground3: var(--winui-text-fill-secondary);
}

/* The glyph Fluent sets beside a validation message. WinUI states no validation
   visual on a text field at all -- neither TextBox_themeresources.xaml nor the
   common dictionary mentions error, invalid or validation -- and the one slot it
   does give a field for subordinate text, Description, is a bare
   ContentPresenter with a foreground and no glyph. So the message here is text
   in the critical fill and nothing else, which is also what carries it: the
   colour and the words say the same thing the icon would.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L340 */
.fui-Field__validationMessageIcon.fui-Field__validationMessageIcon {
  display: none;
}

/* An invalid control is the one validation state Fluent states in the DOM
   rather than in a Griffel atom: the Field pushes aria-invalid onto the
   control it wraps (useFieldControlProps.js, getFieldControlProps), which lets
   the message be addressed from the root. WinUI's counterpart is
   SystemFillColorCritical.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L282
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L78 */
.fui-Field:has([aria-invalid='true']) .fui-Field__validationMessage.fui-Field__validationMessage {
  color: var(--winui-system-fill-critical);
}

/* The warning state announces itself through role="alert" on the message
   (useFieldBase.js), which the error state also sets — so this rule matches
   both and the error rule above, one attribute more specific, takes the fields
   that are actually invalid. WinUI's counterpart is SystemFillColorCaution.
   The success state is left on Fluent's green: it writes neither aria-invalid
   nor role, so nothing in the DOM tells it apart from a field with no
   validation state at all.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L281
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L77 */
.fui-Field__validationMessage.fui-Field__validationMessage[role='alert'] {
  color: var(--winui-system-fill-caution);
}

/* A link's three enabled steps. WinUI walks a HyperlinkButton down the accent
   TEXT ramp -- primary at rest, secondary on pointer, tertiary while pressed --
   which is a different ramp from the accent FILL an accent button takes: it is
   darkened in light and lightened in dark so it stays legible as type rather
   than as a surface. Fluent runs a link on the brand foreground instead, which
   put two link colours on one screen once the toast's action took the WinUI
   step. Scoped to the default appearance, like the disabled step below, because
   Fluent's subtle link is neutral by design.
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

/* A disabled link stays in the accent family in WinUI and is only faded;
   Fluent moves it onto the neutral disabled foreground, which erases the fact
   that it was a link at all. AccentTextFillColorDisabled is the one member of
   the accent text ramp the dictionaries state as a literal. The fade belongs
   to the accent-coloured link only, so it is scoped to the default appearance
   — Fluent's subtle link is neutral by design and has no accent to fade.
   Fluent repeats its own disabled color under :hover and :active, so the
   override repeats there.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L214
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L10 */
.fui-Link.fui-Link[data-winui-appearance='default'][aria-disabled='true'],
.fui-Link.fui-Link[data-winui-appearance='default'][aria-disabled='true']:hover,
.fui-Link.fui-Link[data-winui-appearance='default'][aria-disabled='true']:active {
  color: var(--winui-accent-text-fill-disabled);
}

/* Under forced colors the accent fade carries no meaning — the UA repaints
   every non-system color, so a disabled link would come back indistinguishable
   from an enabled one. Fluent answers that with GrayText, and since a media
   query adds no specificity the override above would otherwise outrank it. */
@media (forced-colors: active) {
  .fui-Link.fui-Link[data-winui-appearance='default'][aria-disabled='true'],
  .fui-Link.fui-Link[data-winui-appearance='default'][aria-disabled='true']:hover,
  .fui-Link.fui-Link[data-winui-appearance='default'][aria-disabled='true']:active {
    color: GrayText;
  }
}
`;
