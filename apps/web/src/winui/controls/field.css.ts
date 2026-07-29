// Field, InfoLabel and Link restyled to the WinUI 3 look.
//
// None of the three has a WinUI counterpart control. A Field is the
// HeaderContentPresenter of a WinUI text control plus its DescriptionPresenter
// line, and a Link is the accent text fill a HyperlinkButton or an inline
// Hyperlink paints; the rules below take their values from those roles.
// InfoLabel contributes only layout plumbing and needs nothing.
//
// Two families WinUI would use here are absent from winui/tokens.ts because
// the theme dictionaries never state them as literals: the SystemFillColor*
// validation ramp and the accent *text* ramp above its disabled member. The
// error, warning and success validation colors and the rest/hover/pressed Link
// colors are therefore left on Fluent's own values.
export const fieldCss = `
/* WinUI gives a text control's header no vertical padding and separates it
   from the control by a flat 8px, where Fluent uses 2px of padding on each
   side plus a 2px margin and then rescales all three with the field size. The
   fixed margin also covers Fluent's large-size ramp, which WinUI has no
   equivalent of. Fluent's horizontal orientation is a layout WinUI has no
   header for, and there the label's vertical padding is what aligns it with
   the control's first text line, so this rule is kept off it. The only
   orientation marker Fluent leaves in the DOM is the root's grid-template-rows
   atom (useFieldStyles.styles.js, useRootStyles.horizontal), which no other
   variant overrides; if Fluent ever rehashes it the negation stops narrowing
   and the rule falls back to both orientations.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L175
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L335 */
.fui-FluentProvider .fui-Field:not(.f1645dqt) > .fui-Field__label {
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
   redefinition of that token on both slots and the two captions stay one
   color; the error state paints itself directly and so keeps Fluent's red.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L340
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/TextBox_themeresources.xaml#L142 */
.fui-FluentProvider .fui-Field__hint,
.fui-FluentProvider .fui-Field__validationMessage {
  --colorNeutralForeground3: var(--winui-text-fill-secondary);
}

/* A disabled link stays in the accent family in WinUI and is only faded;
   Fluent moves it onto the neutral disabled foreground, which erases the fact
   that it was a link at all. AccentTextFillColorDisabled is the one member of
   the accent text ramp the dictionaries state as a literal. Fluent repeats its
   own disabled color under :hover and :active, so the override repeats there.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L214
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L10 */
.fui-FluentProvider .fui-Link[aria-disabled='true'],
.fui-FluentProvider .fui-Link[aria-disabled='true']:hover,
.fui-FluentProvider .fui-Link[aria-disabled='true']:active {
  color: var(--winui-accent-text-fill-disabled);
}

/* Under forced colors the accent fade carries no meaning — the UA repaints
   every non-system color, so a disabled link would come back indistinguishable
   from an enabled one. Fluent answers that with GrayText, and since a media
   query adds no specificity the override above would otherwise outrank it. */
@media (forced-colors: active) {
  .fui-FluentProvider .fui-Link[aria-disabled='true'],
  .fui-FluentProvider .fui-Link[aria-disabled='true']:hover,
  .fui-FluentProvider .fui-Link[aria-disabled='true']:active {
    color: GrayText;
  }
}
`;
