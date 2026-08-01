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

// The success validation state marks nothing on the Field root or the message:
// its only DOM trace is the Griffel atom Fluent puts on the message glyph for
// the success colour, which no other variant carries. Pinned and exported on
// the same terms as the horizontal root atom above -- in
// @fluentui/react-field 9.5.3 this atom is
// `color: var(--colorPaletteGreenForeground1)`.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-field/library/src/components/Field/useFieldStyles.styles.ts#L110-L119
export const fieldSuccessIconAtom = 'ffmvakt';

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
   SystemControlDescriptionTextForegroundBrush, which is a step of its own --
   black or white at 60%, distinct from the 62%/77% the secondary text fill
   carries -- so ../tokens.ts carries it as --winui-text-base-medium and this
   rule spends it. The description presenter also inherits the text control's
   own FontSize, ControlContentThemeFontSize = 14, where Fluent's secondary
   text is the 12px caption ramp; the 14 takes Fluent's matched line height for
   that size. Hint and validation message share one neutral base atom, so the
   colour is written as a redefinition of that token on both slots; the
   validation states below paint over it where they apply.
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
   no validation vocabulary at all -- neither TextBox_themeresources.xaml nor
   the common dictionary names error, invalid or validation -- so there is
   nothing to transcribe and Fluent's three states are kept, re-expressed below
   in WinUI's own SystemFill roles. The glyph goes because the one slot WinUI
   does give a field for subordinate text, Description, is a bare
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
   rather than in a Griffel atom: the Field pushes aria-invalid onto the
   control it wraps (useFieldControlProps.js, getFieldControlProps), which lets
   the message be addressed from the root. WinUI's counterpart is
   SystemFillColorCritical.

   None of the three message colours below states a forced-colors answer,
   because WinUI has none to transcribe: its HighContrast dictionary poisons
   every SystemFill colour to #FF0000 so that a control still reading one
   there shows up as a defect. Forced colours drop all three to the palette's
   own text colour, which is the whole of WinUI's position on the matter.
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
   TEXT ramp -- primary at rest, secondary on pointer, tertiary while pressed --
   which is a different ramp from the accent FILL an accent button takes: it is
   darkened in light and lightened in dark so it stays legible as type rather
   than as a surface. Fluent runs a link on the brand foreground instead, which
   put two link colours on one screen once the toast's action took the WinUI
   step. Scoped to the default appearance, like the disabled step below, because
   Fluent's subtle link is neutral by design.
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

/* A focused link. Fluent's indicator is a doubled underline drawn in
   --colorStrokeFocus2, where WinUI gives a HyperlinkButton the system focus
   visual: two concentric rings pushed 3px outside the control. An inline link
   cannot carry that shape, since the element wraps across lines and the rings
   would break with it, so the underline stays and only its stroke takes
   WinUI's outer focus colour, which ../tokens.ts states per theme. Every
   appearance shares one focus visual in both systems, so this one is not
   scoped to an appearance.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/HyperlinkButton_themeresources.xaml#L62-L63
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258 */
.fui-Link.fui-Link[data-fui-focus-visible] {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
}

/* A disabled link. WinUI names the hyperlink its own disabled token,
   AccentTextFillColorDisabled -- the one member of the accent text ramp the
   dictionaries state as a literal -- and gives it the same value as
   TextFillColorDisabled, so the transcription is a neutral fade that happens to
   arrive through the accent ramp. Fluent's own disabled colour is a different
   neutral, so the token is spent here to keep the ramp's endpoint WinUI's. The
   scope to the default appearance is ours: WinUI has no subtle-hyperlink
   counterpart, so the subtle appearance is left wholly on Fluent's neutral
   ramp, disabled step included. Fluent repeats its own disabled colour under
   :hover and :active, so the override repeats there.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/HyperlinkButton_themeresources.xaml#L8
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L212-L214
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L8-L10 */
.fui-Link.fui-Link[data-winui-appearance='default'][aria-disabled='true'],
.fui-Link.fui-Link[data-winui-appearance='default'][aria-disabled='true']:hover,
.fui-Link.fui-Link[data-winui-appearance='default'][aria-disabled='true']:active {
  color: var(--winui-accent-text-fill-disabled);
}

/* WinUI's HighContrast dictionary takes the hyperlink off the accent ramp
   entirely and names a system colour for each of its four steps:
   SystemControlHyperlinkTextBrush at rest, which is the Hotlight colour CSS
   spells LinkText; SystemControlPageTextBaseMediumBrush on pointer, WindowText,
   which CSS spells CanvasText; SystemControlHighlightBaseMediumLowBrush while
   pressed, the Highlight colour; and SystemControlDisabledBaseMediumLowBrush
   when disabled, GrayText.

   A system-colour keyword is the one author colour forced colours honour, so
   the accent ramp above goes inert there on its own -- but what the user agent
   substitutes depends on the element, and Fluent renders a Link without an
   href as a <button>, which would take ButtonText rather than the hyperlink
   colour. Naming all four steps keeps both element forms on WinUI's answer. A
   media query adds no specificity, so each selector here repeats the one it
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
