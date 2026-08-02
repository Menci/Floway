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

// `cib-color-fill-accent-gradient-balanced-{primary,secondary,tertiary}`.
// Hover and active are the base gradient under a flat black wash, so the
// button darkens as it is pressed.
//
// The three entries are one gradient and two alphas, and that is the shape
// they are published in, because it is the only shape that can be eased.
// `background-image` has a discrete animation type, so a rule that swaps one
// composed gradient for another steps however it is transitioned, while
// `background-color` animates by computed value and a wash painted over the
// fill moves through its alpha:
// https://www.w3.org/TR/css-backgrounds-3/#propdef-background-image
// https://www.w3.org/TR/css-backgrounds-3/#propdef-background-color
//
// The wash sits above the gradient, and Balanced's own entry writes it below.
// A background list paints its first layer topmost, so a wash written second
// sits under an opaque fill and paints nothing, which would leave hover and
// active pixel-identical to rest. Creative and Precise, declared in the same
// block from the same shape, write the wash first; that is the order taken
// here, so hover and active read as the states they are named for:
// https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/dark.scss#L268-L300
const wash = (alpha: number) => `rgba(0, 0, 0, ${alpha})`;

export const bingAccentGradient = 'linear-gradient(130deg, #2870EA 20%, #1B4AEF 77.5%)';
export const bingAccentWashResting = wash(0);
export const bingAccentWashHover = wash(0.1);
export const bingAccentWashActive = wash(0.2);

// `cib-color-foreground-accent-balanced-{primary,secondary}`. Dark resolves
// both steps to the same value, so an accent glyph does not change colour on
// hover there and the row's own background carries the state; that is Bing's
// table, not an omission here.
export const bingAccentForeground = 'light-dark(#174AE4, #A2B7F4)';
export const bingAccentForegroundHover = 'light-dark(#1543CD, #A2B7F4)';

// `cib-color-foreground-on-accent-selected` is the slot the compose button
// names for its own label, and `-primary` beside it is the same `#FFFFFF` in
// both the light and the dark dictionary and in all three tones. Fluent's own
// on-brand token cannot stand in for it: WinUI's accent is light in dark mode,
// so its "text on accent" resolves to a dark foreground, and what sits under
// this text is Bing's accent, not WinUI's.
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

// `components.actionBar.searchBorderRadius` (24px) and
// `measurements.borderRadius.borderRadiusXLarge` (12px), restated below with
// the rest of the bar's geometry. The corner is a state, not a function of
// height: the bar is a pill until it holds something, and squares off to a
// quarter of its height the moment it does. Bing keyed this on having content
// rather than on having wrapped, which is why its corners are never caught
// mid-blob.
export const bingComposerRadiusResting = '20px';
export const bingComposerRadiusFilled = '10px';

// The same rule that tightens the corner also raises the bar's floor, and that
// half is deliberately not taken. The room it opens is for a bottom bar
// carrying a character counter, which this composer has no counterpart for; the
// bar would grow downward into a strip holding nothing.

// `static.motion.duration.fast` and `easingFunction.motionIn` — the duration
// and easing the bar declares beside its own `transition-property`, and the
// pair the compose button's fill declares beside its.
export const bingComposerTransitionDuration = '187ms';
export const bingComposerTransitionEasing = 'cubic-bezier(0, 0, 0, 1)';

// `cib-action-bar`'s `.button-compose:active::before`. That pseudo-element
// lists `transform` alone in its `transition-property`, so the press is the
// one state change the original animates on this button; hover and active
// restate its `background` and step. Search `.button-compose::before` in the
// decompressed bundle for the rule and the two swaps beside it — the same
// capture the accent above is read out of.
export const bingComposePressScale = 'scale3d(0.971, 0.9583, 1)';

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
// two controls and their gutter, which is the case the original sized
// separately; the column gap between the bar and the compose button is half
// the line, and is ours — the original stands the two in separate containers
// and never spaces them.
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

// The only cap the bundle puts on the field, and it sits behind an
// `as-ghost-placement` host flag the shipped desktop path never set, so there
// the field simply grew without bound — which a page-sized composer can afford
// and a panel-sized one cannot; this is Bing's own number for the same job.
export const bingComposerMaxHeight = '50vh';

// `cib-shadow-card` — the bar's edge, and the only shadow the composer row
// actually shows. The broom button declares `elevation4`, which in light is
// the very same pair of layers the card resolves to, but it declares it on the
// pseudo-element that carries its gradient, sized to the button's whole box
// inside a button that is `overflow: hidden`; a shadow paints outside its own
// border box, so the clip removes all of it. Measured against the original's
// own stylesheet, every row above and below the button reads flat page colour
// while the bar reads a shadow on both sides. The button is not lifted.
//
// In light the card is a shadow; in dark the same token stops being one and
// becomes a 1px white ring, which is the entire dark-mode edge mechanism. In
// forced colors both forms drop out together, `box-shadow` computing to `none`
// whatever it holds:
// https://www.w3.org/TR/css-color-adjust-1/#forced-colors-properties
//
// `light-dark()` only takes colours, so each theme's layers are written out and
// the ones that do not apply are made transparent. The layer geometry is the
// source's; only the switching is ours.
export const bingCardShadow = [
  '0px 0px 0px 1px light-dark(transparent, rgba(255, 255, 255, 0.2))',
  '0px 0.3px 0.9px light-dark(rgba(0, 0, 0, 0.12), transparent)',
  '0px 1.6px 3.6px light-dark(rgba(0, 0, 0, 0.16), transparent)',
].join(', ');
