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
