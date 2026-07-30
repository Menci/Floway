// The playground is a transcription of the 2023 Bing chat UI, so its accent
// comes from that UI's own design tokens rather than from a value picked to
// look close. The tokens were read out of the SERP bundle that defines the
// `cib-*` web components — Microsoft never wrote the custom properties into
// the CSS; FAST's `DesignToken.create` synthesizes `--${cssCustomPropertyName}`
// at runtime from plain JS value trees, so a grep for `--cib-color-…: #hex`
// finds nothing and the trees have to be read instead:
// https://web.archive.org/web/20230915051900id_/https://r.bing.com/rp/P4yYA1dNC8p3siHxVjKFOc2pFio.gz.js
// A second, independently minified copy agrees on every value:
// https://web.archive.org/web/20231003014932id_/https://r.bing.com/rp/tjUrvvMliUK9Hgj2hXeLmHCOqrU.gz.js
// weaigc/bingo mirrors the same tree verbatim as readable SCSS, which is the
// easiest place to check any of this by eye:
// https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/dark.scss#L66
//
// Bing carried three conversation tones — Creative, Balanced, Precise — and
// varied the accent by tone, not by theme. The playground has no tone, so it
// takes Balanced, which was Bing's default.
//
// The theme split is the part worth stating plainly, because it is the
// opposite of what an approximation would guess: the gradient does NOT change
// between light and dark. Both theme objects reference the same three gradient
// values; what flips is the flat accent foreground, the surfaces and the
// strokes. Anything here that reads as one value for both themes is one value
// in the source too.

// `background-fill-accent-gradient-balanced-{primary,secondary,tertiary}`.
// Hover and active are the base gradient under a flat black wash, so the
// button darkens as it is pressed.
const ACCENT_GRADIENT = 'linear-gradient(130deg, #2870EA 20%, #1B4AEF 77.5%)';
const wash = (alpha: number) =>
  `${ACCENT_GRADIENT}, linear-gradient(0deg, rgba(0, 0, 0, ${alpha}), rgba(0, 0, 0, ${alpha}))`;

export const bingAccentGradient = ACCENT_GRADIENT;
export const bingAccentGradientHover = wash(0.1);
export const bingAccentGradientActive = wash(0.2);

// `foreground-accent-balanced-{primary,secondary}`. Dark resolves both steps to
// the same value, so an accent glyph does not change colour on hover there and
// the row's own background carries the state; that is Bing's table, not an
// omission here.
export const bingAccentForeground = 'light-dark(#174AE4, #A2B7F4)';
export const bingAccentForegroundHover = 'light-dark(#1543CD, #A2B7F4)';

// `foreground-on-accent-{primary,selected}` — `#FFFFFF`, in every theme and
// every tone. Fluent's own on-brand token cannot stand in for it: WinUI's
// accent is light in dark mode, so its "text on accent" resolves to a dark
// foreground, and what sits under this text is Bing's accent, not WinUI's.
export const bingOnAccentForeground = '#FFFFFF';

// The composer's field, the broom button's label and a message's body text are
// one step of the ramp — Body2, `--cib-type-body2-*`, 16px on a 24px line. The
// rendered answer sits one step above them at 18px/24px. What Bing was really
// saying is that you type at the size you read at, and the answer is the one
// thing set larger.
//
// Body2 was also the browser's default size: `cib-serp` sets a family and no
// size, so 16px was simply the root. The dashboard's root is 14px, so the same
// ramp lands one step lower here and the composer takes Body1 — 14px on a 20px
// line, Bing's own next step down. The pixel count is not the thing being
// preserved; the equality with the message body is.
export const bingComposerFontSize = '14px';
export const bingComposerLineHeight = '20px';
export const bingComposerFontWeight = 400;

// `components.actionBar.searchBorderRadius` and
// `measurements.borderRadius.borderRadiusXLarge`. The corner is a state, not a
// function of height: the bar is a pill until it holds something, and squares
// off to 12px the moment it does. Bing keyed this on having content rather than
// on having wrapped, which is why its corners are never caught mid-blob.
export const bingComposerRadiusResting = '20px';
export const bingComposerRadiusFilled = '10px';

// `static.motion.duration.fast` and `easingFunction.motionIn`, the pair the
// composer names in its own `transition-property`.
export const bingComposerTransitionDuration = '187ms';
export const bingComposerTransitionEasing = 'cubic-bezier(0, 0, 0, 1)';

// The bar's geometry is a function of its line, not a set of loose numbers:
// Bing's `13px 11px` sums to 24px, exactly the Body2 line it sits around, so
// the resting bar is twice its line — 48px — and everything else follows from
// that. The compose button is the bar's full height; a control plus its gutter
// fills the same height; the resting corner is half of it and the filled
// corner a quarter. Carrying those numbers over unscaled while the type moved
// down a step is what made the bar look padded: 24px of padding around a 20px
// line instead of 20px.
//
// So the whole set is restated against a 20px line. The trailing inset holds
// two controls, which is the case the original sized separately.
export const bingComposerPaddingBlock = '11px 9px';
export const bingComposerButtonSize = '30px';
export const bingComposerGutterPadding = '5px 7px';
export const bingComposeButtonSize = '40px';
export const bingComposerColumnGap = '10px';
export const bingComposerTrailingInset = '74px';

// The field's own text inset. The bar's leading inset is sized to clear a
// control the playground's composer does not have, so this is the inset a
// message's content carries instead, and the text of the two lines up.
export const bingComposerLeadingInset = '16px';

// The only cap the bundle expresses. On the shipped desktop path it sits behind
// a disabled flag and the field simply grows without bound, which a page-sized
// composer can afford and a panel-sized one cannot; this is Bing's own number
// for the same job.
export const bingComposerMaxHeight = '50vh';

// `shadows.defaults.card` — the bar's edge, and the only shadow the composer
// row actually shows. The broom button declares `elevation4`, but on the
// pseudo-element that carries its gradient, sized to the button's whole box
// inside a button that is `overflow: hidden`; a shadow paints outside its own
// border box, so the clip removes all of it. Measured against the original's
// own stylesheet, every row above and below the button reads flat page colour
// while the bar reads a shadow on both sides. The button is not lifted.
//
// In light the card is a shadow; in dark the same token stops being one and
// becomes a 1px white ring, which is the entire dark-mode edge mechanism.
//
// `light-dark()` only takes colours, so each theme's layers are written out and
// the ones that do not apply are made transparent. The layer geometry is the
// source's; only the switching is ours.
export const bingCardShadow = [
  '0px 0px 0px 1px light-dark(transparent, rgba(255, 255, 255, 0.2))',
  '0px 0.3px 0.9px light-dark(rgba(0, 0, 0, 0.12), transparent)',
  '0px 1.6px 3.6px light-dark(rgba(0, 0, 0, 0.16), transparent)',
].join(', ');
