// Field and InfoLabel restyled to the WinUI 3 look; neither has a WinUI
// counterpart control, so their rules take their values from the roles they
// stand in for. Link has two candidates -- the inline Hyperlink and the
// standalone HyperlinkButton, which agree on colour and differ on the
// underline -- and every link in this app is the HyperlinkButton, by decision.
//
// The accent text ramp a Link walks appears in no theme dictionary as a
// literal, so ../tokens.ts transcribes the ramp Windows generates for its own
// default accent colour, at the cost of that one assumption.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L297

import { focusRectStrokes } from '../focus-rect.css';

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
   The header's own colour is left on the modern text ramp rather than taken
   from TextControlHeaderForeground: that key is on the legacy system-brush
   layer at BaseHigh, a pure black no other label in this layer wears, and a
   Field label sitting darker than the CheckBox label beside it would read as a
   defect rather than as WinUI.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L175
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L335
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L4812 */
.fui-Field:not(.${fieldHorizontalRootAtom}) > .fui-Field__label.fui-Field__label {
  padding-block: 0;
  margin-block-end: 8px;
}

/* The header's disabled step, which Fluent does not state: its Field passes the
   wrapped control's disabled state to no attribute, class or atom on the label
   slot, so the label alone stayed at its rest colour while the control beside
   it greyed out. :has on the wrapped control is the state Fluent leaves
   readable.

   The modern dictionary carries a header-disabled brush for every field-shaped
   control that states one -- ComboBox, DatePicker, TimePicker and
   CalendarDatePicker all key it to TextFillColorDisabled -- and only TextBox
   leaves the key to the legacy layer, so the label greys to the same step its
   control does.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L47
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/ComboBox/ComboBox_themeresources.xaml#L257
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/DatePicker_themeresources.xaml#L14
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CalendarDatePicker_themeresources.xaml#L18
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L256-L260 */
.fui-Field:has(:disabled) > .fui-Field__label.fui-Field__label,
.fui-Field:has([aria-disabled='true']) > .fui-Field__label.fui-Field__label {
  color: var(--winui-text-fill-disabled);
}

/* WinUI paints a description line with
   SystemControlDescriptionTextForegroundBrush (../tokens.ts:
   --winui-text-base-medium) at the text control's own 14px FontSize, where
   Fluent's secondary text is the 12px caption ramp. Hint and validation message
   share one neutral base atom, so the colour is written as a redefinition of
   that token on both slots. DescriptionPresenter carries no Margin, where
   Fluent lifts its subordinate line off the control by spacingVerticalXXS, so
   the gutter is taken back out.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L340
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L186
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L36 */
.fui-Field__hint.fui-Field__hint,
.fui-Field__validationMessage.fui-Field__validationMessage {
  --colorNeutralForeground3: var(--winui-text-base-medium);
  font-size: var(--fontSizeBase300);
  line-height: var(--lineHeightBase300);
  margin-top: 0;
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

/* The required marker has no WinUI counterpart -- a TextBox header states none,
   and neither the CheckBox nor the RadioButton template carries a marker part
   beside its bare ContentPresenter -- so it is answered as an internal
   invariant instead: every other signal in this column was re-expressed in a
   WinUI SystemFill role, and leaving this one on Fluent's own red put two
   different reds in the same column of a form. Stated on the Label slot rather
   than under a Field, because Checkbox and Radio render their own label outside
   the Field label and every marker in the app is this same affordance.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L282
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/CheckBox_themeresources.xaml#L598-L613
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/RadioButton_themeresources.xaml#L366-L379 */
.fui-Label__required.fui-Label__required {
  color: var(--winui-system-fill-critical);
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

/* The info glyph is a subtle button in WinUI terms, and a subtle button says
   pointer with its fill: SubtleButtonBackground walks transparent, secondary,
   tertiary while SubtleButtonForeground holds TextFillColorPrimary from rest
   through PointerOver and steps one down the text ramp on Pressed. Fluent
   inverts that -- its fill stays transparent and its foreground climbs the
   brand ramp on hover, on press and for as long as the tip is open -- so both
   halves are restated here. The glyph rests one step lower than a subtle
   button's label, on colorNeutralForeground2, which ../theme.ts resolves to
   TextFillColorSecondary, so holding and then stepping once lands on secondary
   and tertiary. A flyout merely being open is a state WinUI states no
   foreground for, so the selected step is the rest colour.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L17-L24 */
.fui-InfoButton.fui-InfoButton {
  --colorTransparentBackgroundHover: var(--winui-subtle-fill-secondary);
  --colorTransparentBackgroundPressed: var(--winui-subtle-fill-tertiary);
  --colorNeutralForeground2BrandHover: var(--winui-text-fill-secondary);
  --colorNeutralForeground2BrandPressed: var(--winui-text-fill-tertiary);
  --colorNeutralForeground2BrandSelected: var(--winui-text-fill-secondary);
}

/* Fluent renders both weights of the bundled info icon and swaps which one is
   displayed on hover and while the tip is open. Every state a subtle button
   names is a brush -- fill, foreground and stroke, and nothing else -- so the
   outline weight is pinned for all of them.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Button_themeresources.xaml#L17-L28 */
.fui-InfoButton.fui-InfoButton .fui-Icon-filled.fui-Icon-filled {
  display: none;
}

.fui-InfoButton.fui-InfoButton .fui-Icon-regular.fui-Icon-regular {
  display: inline-flex;
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

/* No link in this app underlines, in any state. WinUI 3 ships
   HyperlinkUnderlineVisible as False, inverting the value dxaml's generic.xaml
   still carries, and its two hyperlink forms read that flag differently:
   HyperlinkButton drops the underline everywhere, while the inline Hyperlink
   keeps it at rest. Both forms are available and the app takes the
   HyperlinkButton for all of them, so Fluent's inline prop -- which underlines
   at rest, standing for the form this app does not use -- has nothing to say
   here either.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Hyperlink_themeresources.xaml#L20
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/HyperlinkButton_themeresources.xaml#L62-L63
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/core/text/TextBlock/Hyperlink.cpp#L669-L671
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/lib/HyperLinkButton_Partial.cpp#L207-L212
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L5926 */
.fui-Link.fui-Link,
.fui-Link.fui-Link:hover,
.fui-Link.fui-Link:active,
.fui-Link.fui-Link:focus-visible {
  text-decoration-line: none;
}

/* Which leaves the focus rect to say focus, as it does for everything else
   focusable here -- Fluent says it with a doubled underline, which this app has
   no underline to double. A link's box is drawn tight around its text, so it
   states the room the strokes need and takes the same width back out of its
   margin, leaving the line it sits in as it was. */
.fui-Link.fui-Link {
  border-radius: var(--winui-control-corner-radius);
  margin-inline: -5px;
  padding-block: 1px;
  padding-inline: 5px;
}

.fui-Link.fui-Link:focus-visible {${focusRectStrokes}}

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
   system colours, and is the one theme where both hyperlink forms draw the
   underline unconditionally, so the rule above is undone here. All four colour
   steps are named rather than left to the user agent because Fluent renders an
   href-less Link as a <button>, which would take ButtonText instead of the
   hyperlink colour. A media query adds no specificity, so each selector
   repeats the one it overrides.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/HyperlinkButton_themeresources.xaml#L34-L38
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L2083
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L2097
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L2073
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/dxaml/xcp/dxaml/themes/generic.xaml#L2026
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
@media (forced-colors: active) {
  .fui-Link.fui-Link,
  .fui-Link.fui-Link:hover,
  .fui-Link.fui-Link:active,
  .fui-Link.fui-Link:focus-visible {
    text-decoration-line: underline;
  }

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
