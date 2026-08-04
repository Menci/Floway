// The playground transcribes the 2023 Bing chat UI, so every value below is
// read out of the SERP bundle that defines the `cib-*` components. FAST's
// `DesignToken.create` synthesizes the custom properties at runtime from JS
// value trees, so the CSS never spells them and the trees have to be read:
// https://web.archive.org/web/20230915051900id_/https://r.bing.com/rp/P4yYA1dNC8p3siHxVjKFOc2pFio.gz.js
// https://web.archive.org/web/20231003014932id_/https://r.bing.com/rp/tjUrvvMliUK9Hgj2hXeLmHCOqrU.gz.js
// weaigc/bingo mirrors the same tree verbatim as readable SCSS:
// https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/dark.scss#L66
//
// Bing varied the accent by conversation tone, not by theme; the playground has
// no tone and takes Balanced, Bing's default. The gradient is therefore one
// value across light and dark -- what flips is the flat accent foreground, the
// surfaces and the strokes.

// `cib-color-fill-accent-gradient-balanced-{primary,secondary,tertiary}`: one
// gradient under a flat black wash whose alpha carries hover and active.
// `background-image` has a discrete animation type, so swapping composed
// gradients steps however it is transitioned, while a wash animates by
// computed value:
// https://www.w3.org/TR/css-backgrounds-3/#propdef-background-image
// https://www.w3.org/TR/css-backgrounds-3/#propdef-background-color
//
// Which layer the wash sits in is decided where the two are stacked, in
// ./composer.tsx.
const wash = (alpha: number) => `rgba(0, 0, 0, ${alpha})`;

export const bingAccentGradient = 'linear-gradient(130deg, #2870EA 20%, #1B4AEF 77.5%)';
export const bingAccentWashResting = wash(0);
export const bingAccentWashHover = wash(0.1);
export const bingAccentWashActive = wash(0.2);

// `cib-color-foreground-accent-balanced-{primary,secondary}`. Dark resolves
// both steps to the same value in Bing's own table, so an accent glyph does not
// change colour on hover there.
export const bingAccentForeground = { light: '#174AE4', dark: '#A2B7F4' };
export const bingAccentForegroundHover = { light: '#1543CD', dark: '#A2B7F4' };

// `cib-color-foreground-on-accent-selected`, the compose button's own label
// slot. Fluent's on-brand token cannot stand in: WinUI's accent is light in
// dark mode, so its text-on-accent is dark, and what sits under this text is
// Bing's accent.
export const bingOnAccentForeground = '#FFFFFF';

// Bing set the field and the message body at one step of its ramp -- Body2,
// `--cib-type-body2-*`, 16px/24px, which was simply the browser default root.
// The dashboard's root is 14px, so the ramp lands a step lower and the composer
// takes Bing's Body1. What is preserved is the equality with the message body,
// not the pixel count.
export const bingComposerFontSize = '14px';
export const bingComposerLineHeight = '20px';
export const bingComposerFontWeight = 400;

// `components.actionBar.searchBorderRadius` (24px) and
// `measurements.borderRadius.borderRadiusXLarge` (12px), rescaled with the rest
// of the bar's geometry below. The corner is keyed on the bar having content,
// not on having wrapped, so it is never caught mid-blob.
export const bingComposerRadiusResting = '20px';
export const bingComposerRadiusFilled = '10px';

// The same rule raises the bar's floor to clear a character counter, which this
// composer has no counterpart for, so that half is not taken.

// `static.motion.duration.fast` and `easingFunction.motionIn`.
export const bingComposerTransitionDuration = '187ms';
export const bingComposerTransitionEasing = 'cubic-bezier(0, 0, 0, 1)';

// `cib-action-bar`'s `.button-compose:active::before`, whose
// `transition-property` lists `transform` alone -- the press is the one state
// change the original animates on this button.
export const bingComposePressScale = 'scale3d(0.971, 0.9583, 1)';

// The bar's geometry is a function of its line: Bing's `13px 11px` sums to the
// 24px Body2 line, making the resting bar twice its line, the compose button
// its full height, the resting corner half of it and the filled corner a
// quarter. The type moved down a step here, so the whole set is restated
// against a 20px line rather than carried over unscaled. The column gap is
// ours; the original stands the bar and the button in separate containers.
export const bingComposerPaddingBlock = '11px 9px';
export const bingComposerButtonSize = '30px';
export const bingComposerGutterPadding = '5px 7px';
export const bingComposeButtonSize = '40px';
export const bingComposerColumnGap = '10px';
export const bingComposerTrailingInset = '74px';

// The field's own text inset: the bar's leading inset clears a control this
// composer does not have, so a message's content carries this one instead and
// the text of the two lines up.
export const bingComposerLeadingInset = '16px';

// The only cap the bundle puts on the field. It sits behind an
// `as-ghost-placement` flag the shipped desktop path never set, where the field
// grew unbounded -- affordable for a page-sized composer, not a panel-sized one.
export const bingComposerMaxHeight = '50vh';

// `cib-shadow-card`, the only shadow the composer row shows: the broom button
// declares `elevation4` on the pseudo-element carrying its gradient, inside a
// button that is `overflow: hidden`, so the clip removes all of it.
//
// In light the token is a shadow; in dark it becomes a 1px white ring, which is
// the entire dark-mode edge mechanism. In forced colors both drop out together,
// `box-shadow` computing to `none` whatever it holds:
// https://www.w3.org/TR/css-color-adjust-1/#forced-colors-properties
export const bingCardShadow = {
  boxShadow: [
    '0px 0.3px 0.9px rgba(0, 0, 0, 0.12)',
    '0px 1.6px 3.6px rgba(0, 0, 0, 0.16)',
  ].join(', '),
  '@media (prefers-color-scheme: dark)': {
    boxShadow: '0px 0px 0px 1px rgba(255, 255, 255, 0.2)',
  },
};

// `cib-shadow-elevation-4`, which a user bubble takes instead of the card
// shadow.
// https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/globals.scss#L178-L179
// https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/dark.scss#L155
export const bingElevation4 = {
  boxShadow: [
    '0px 0.3px 0.9px rgba(0, 0, 0, 0.12)',
    '0px 1.6px 3.6px rgba(0, 0, 0, 0.16)',
  ].join(', '),
  '@media (prefers-color-scheme: dark)': {
    boxShadow: [
      '0px 2px 4px rgba(0, 0, 0, 0.28)',
      '0px 0px 2px rgba(0, 0, 0, 0.24)',
    ].join(', '),
  },
};

// `cib-border-radius-extra-large`, the corner of a transcript bubble, as a pixel
// constant: a rem step would move with the root size.
// https://github.com/weaigc/bingo/blob/6d6d74220b343cbbd3c6eadc0b9cb39a9aedd1f3/src/app/globals.scss#L192
export const bingMessageRadius = '12px';
