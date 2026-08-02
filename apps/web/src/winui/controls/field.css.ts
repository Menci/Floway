// Field, InfoLabel and Link restyled to the WinUI 3 look. None of the three has
// a WinUI counterpart control, so the rules below take their values from the
// roles they stand in for.
//
// The accent text ramp a Link walks appears in no theme dictionary as a
// literal, so ../tokens.ts transcribes the ramp Windows generates for its own
// default accent colour, at the cost of that one assumption.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L297

// Fluent's only DOM marker for a Field's horizontal orientation is the Griffel
// atom for `useRootStyles.horizontal`, a content hash pinned to the resolved
// @fluentui/react-field 9.5.3 and exported so a suite fails the moment a Fluent
// bump rehashes it.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-field/library/src/components/Field/useFieldStyles.styles.ts#L29-L32
export const fieldHorizontalRootAtom = 'f1645dqt';

// The success validation state's only DOM trace is the Griffel atom Fluent puts
// on the message glyph for the success colour — in @fluentui/react-field 9.5.3,
// `color: var(--colorPaletteGreenForeground1)`. A Griffel atom hashes property
// and value together, so a rename of the palette token rehashes it too and the
// rule below silently stops matching.
// https://github.com/microsoft/fluentui/blob/6dee27b023a2d989f032b4adacb2135d336a67fb/packages/react-components/react-field/library/src/components/Field/useFieldStyles.styles.ts#L117-L119
export const fieldSuccessIconAtom = 'ffmvakt';

export const fieldCss = `
/* Keep header and control at their intrinsic sizes so mixed controls retain the
   same 8px header gap when a parent grid stretches the Field to a taller
   sibling. */
.fui-Field.fui-Field:not(.${fieldHorizontalRootAtom}) {
  align-content: start;
}

/* WinUI gives a header no vertical padding and a flat 8px gap, where Fluent
   scales both with the field size. Fluent's horizontal orientation has no WinUI
   header to transcribe and relies on the label's vertical padding to align it
   with the control's first text line, so the horizontal root atom is negated.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L175
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L335 */
.fui-Field:not(.${fieldHorizontalRootAtom}) > .fui-Field__label.fui-Field__label {
  padding-block: 0;
  margin-bottom: 8px;
}

/* WinUI paints a description line with
   SystemControlDescriptionTextForegroundBrush (../tokens.ts:
   --winui-text-base-medium) at the text control's own 14px FontSize, where
   Fluent's secondary text is the 12px caption ramp. Hint and validation message
   share one neutral base atom, so the colour is written as a redefinition of
   that token on both slots.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L340
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L186
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L36 */
.fui-Field__hint.fui-Field__hint,
.fui-Field__validationMessage.fui-Field__validationMessage {
  --colorNeutralForeground3: var(--winui-text-base-medium);
  font-size: var(--fontSizeBase300);
  line-height: var(--lineHeightBase300);
}

/* WinUI's only subordinate-text slot, Description, is a bare ContentPresenter
   with no icon column, so Fluent's validation glyph goes while its three states
   are kept and re-expressed below in WinUI's SystemFill roles.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L340 */
.fui-Field__validationMessageIcon.fui-Field__validationMessageIcon {
  display: none;
}

/* Fluent indents the message by the column the glyph sat in, so removing the
   glyph alone leaves the words hanging off the field's leading edge. */
.fui-Field__validationMessage.fui-Field__validationMessage {
  padding-inline-start: 0;
}

/* Invalid is the one validation state Fluent writes into the DOM, as
   aria-invalid on the wrapped control; WinUI's counterpart is
   SystemFillColorCritical. None of the three message colours states a
   forced-colors answer, because WinUI's HighContrast dictionary poisons every
   SystemFill to #FF0000 to make a control still reading one there visible as a
   defect.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L282
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L78
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L578-L580
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
.fui-Field:has([aria-invalid='true']) .fui-Field__validationMessage.fui-Field__validationMessage {
  color: var(--winui-system-fill-critical);
}

/* Warning and error both set role="alert", so this rule matches invalid fields
   too and relies on the error rule above being one attribute more specific.
   WinUI's counterpart is SystemFillColorCaution.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L281
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L77 */
.fui-Field__validationMessage.fui-Field__validationMessage[role='alert'] {
  color: var(--winui-system-fill-caution);
}

/* Success writes neither aria-invalid nor role, so it is addressed through the
   pinned glyph atom -- the glyph is hidden, not removed, and still answers a
   selector. Fluent says success in that icon alone, which this sheet takes
   away, so the message carries the state instead. WinUI's counterpart is
   SystemFillColorSuccess.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L280
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L76 */
.fui-Field__validationMessage.fui-Field__validationMessage:has(> .fui-Field__validationMessageIcon.${fieldSuccessIconAtom}) {
  color: var(--winui-system-fill-success);
}

/* A link's three enabled steps. WinUI walks a HyperlinkButton down the accent
   TEXT ramp, not the accent FILL ramp an accent button takes. Scoped to the
   default appearance, like the disabled step below, because Fluent's subtle
   link is neutral by design.
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

/* A focused link. WinUI's two concentric rings 3px outside the control cannot
   follow an inline link across a line break, so Fluent's doubled underline
   stays and only its stroke takes WinUI's outer focus colour. Unscoped because
   every appearance shares one focus visual in both systems.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/HyperlinkButton_themeresources.xaml#L62-L63
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L54
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L258 */
.fui-Link.fui-Link[data-fui-focus-visible] {
  --colorStrokeFocus2: var(--winui-focus-stroke-outer);
}

/* A disabled link. AccentTextFillColorDisabled arrives through the accent ramp
   but carries TextFillColorDisabled's neutral fade, a different neutral from
   Fluent's own. WinUI has no subtle-hyperlink counterpart, so the subtle
   appearance stays wholly on Fluent's ramp. Fluent repeats its disabled colour
   under :hover and :active, so the override repeats there.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/HyperlinkButton_themeresources.xaml#L8
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L212-L214
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L8-L10 */
.fui-Link.fui-Link[data-winui-appearance='default'][aria-disabled='true'],
.fui-Link.fui-Link[data-winui-appearance='default'][aria-disabled='true']:hover,
.fui-Link.fui-Link[data-winui-appearance='default'][aria-disabled='true']:active {
  color: var(--winui-accent-text-fill-disabled);
}

/* WinUI's HighContrast dictionary takes the hyperlink off the accent ramp onto
   system colours. All four steps are named rather than left to the user agent
   because Fluent renders an href-less Link as a <button>, which would take
   ButtonText instead of the hyperlink colour. A media query adds no
   specificity, so each selector repeats the one it overrides.
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
