import { doubled } from './selectors';

// The InfoBar severity idiom, shared by every surface in this layer that carries
// one. InfoBar is the only WinUI control with a severity, so a control restyled
// onto that chassis takes the whole of it: the card tint, the disc-and-knockout
// mark, and the icon box the mark sits in.
//
// Fluent names its four severities with the intents `error`, `warning`,
// `success` and `info`, and each maps onto exactly one SystemFillColor family.
// The card takes that family's Background step and the mark its plain one.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L5-L12
//
// The theme dictionaries are byte-identical between Light and Default, so one
// mapping serves both themes and the difference falls out of the token values.
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L4-L41
export const severityFills = [
  ['error', 'critical'],
  ['warning', 'caution'],
  ['success', 'success'],
  ['info', 'attention'],
] as const;

/**
 * Paints a control's severity from `data-winui-intent`, which the runtime
 * chokepoint in `../appearance.ts` stamps and which also puts the matching
 * circle glyph in the icon slot.
 *
 * `card` is the element taking the severity background; `icon` is the slot
 * holding the glyph. Both take the doubling convention `./selectors.ts`
 * records wherever they carry a declaration.
 *
 * `ground` is for a card that floats. Only the Attention step of this family is
 * translucent -- half in light, a twentieth in dark -- and a bar laid inline
 * over the page can carry that because the page supplies the opacity. A surface
 * with arbitrary content beneath it cannot: the same wash leaves buttons legible
 * through the card. Passing a ground composites the tint over it, which is what
 * an inline bar resolves to anyway, and leaves the three opaque steps as they
 * are.
 * https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L235
 */
export const severityCss = ({ card, icon, ground }: { card: string; icon: string; ground?: string }) => `
/* InfoBarIconMargin, the thickness 0,16,14,16, whose block terms pin the glyph
   to the first line of the message rather than to the middle of the card --
   hence align-self. 16 + 16 + 16 is InfoBarMinHeight, so the two placements
   differ exactly when the body wraps, the case the margin exists for. The box
   is that margin and InfoBarIconFontSize alone, so a slot Fluent pads is
   cleared. It is the box of the standard mark and of a caller's own artwork
   alike: InfoBar gives UserIconBox the same margin and caps it at the same
   size.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar.xaml#L107-L111
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L76
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L77 */
${doubled(icon)} {
  align-self: start;
  padding: 0;
  font-size: 16px;
  margin-block: 16px;
  margin-inline-end: 14px;
}

/* WinUI stacks a severity-coloured disc under a symbol painted in
   TextFillColorInverse; a Fluent *Filled circle glyph is that silhouette
   inverted, one path with the symbol as negative space, so the disc behind it
   carries the inverse layer. All four are an r=8 circle in a 20 unit box -- 80%
   of the closest side on a square 1em icon, with the stops just inside that
   edge so no ring escapes from under the glyph.

   The disc and the severity colour reach the standard mark alone. InfoBar
   paints neither onto UserIconBox, and a caller's artwork is opaque to us: it
   need not be a silhouette with a hole, and anything else lands the disc in
   front of the card instead of behind a symbol.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar.xaml#L107-L111
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L13-L16 */
${doubled(icon)}[data-winui-severity-mark] {
  background: radial-gradient(
    closest-side,
    var(--winui-text-fill-inverse) 79%,
    transparent 80%
  );
}
${severityFills.map(([intent, fill]) => `
${doubled(card)}[data-winui-intent='${intent}'] {
${ground === undefined
  ? `  background-color: var(--winui-system-fill-${fill}-background);`
  : `  background-color: ${ground};
  background-image: linear-gradient(var(--winui-system-fill-${fill}-background), var(--winui-system-fill-${fill}-background));`}
}

${card}[data-winui-intent='${intent}'] ${doubled(icon)}[data-winui-severity-mark] {
  color: var(--winui-system-fill-${fill});
}`).join('\n')}

/* Forced colours. WinUI's HighContrast dictionary drops the severity fill and
   doubles the stroke; the user agent's forced adjustment already lands the
   colours, leaving only the thickness to state. It cannot reach the badge:
   background-image is not among the forced properties, so the gradient carrying
   HighlightText would go on painting the inverse text fill of the underlying
   scheme. Opting the badge out is what lets both layers be named. A media query
   adds no specificity, so the selector matches the severity rules it overrides.
   https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/InfoBar/InfoBar_themeresources.xaml#L42-L60
   https://drafts.csswg.org/css-color-adjust/#forced-colors-properties */
@media (forced-colors: active) {
  ${doubled(card)} {
    border-width: 2px;
  }

  ${card}[data-winui-intent] ${doubled(icon)}[data-winui-severity-mark] {
    forced-color-adjust: none;
    color: Highlight;
    background: radial-gradient(
      closest-side,
      HighlightText 79%,
      transparent 80%
    );
  }
}
`;
