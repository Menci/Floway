import type { CSSProperties } from 'react';

import { fluentComponents } from '../../fluent';
import { alphaHex, blendHex, readableTone } from '../../lib/color';

const { makeStyles } = fluentComponents;

/** A hue that reads the same in both schemes, or one stated per scheme. */
export type BadgeHue = string | { light: string; dark: string };

// The hardest end of each scheme's badge-surface range: in light the selected
// request row (Fluent brand 160); in dark a card washed by
// SubtleFillColorSecondary (#ffffff0f over #373737).
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L26
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L56
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L71
// https://github.com/microsoft/microsoft-ui-xaml/blob/188f602b27cdb47572b28c380e9c087b02e1ccee/controls/dev/CommonStyles/Common_themeresources_any.xaml#L230
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/tokens/src/global/brandColors.ts#L5-L19
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/tokens/src/alias/lightColor.ts#L138
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/tokens/src/alias/darkColor.ts#L132
const HARDEST_BADGE_SURFACE = { light: '#EBF3FC', dark: '#434343' } as const;
const BADGE_FILL_ALPHA = 0.1;
const BADGE_STROKE_ALPHA = 0.35;

// The three painted properties stay on the element's own style attribute,
// which is what outranks Fluent's chip styles and the WinUI layer's
// doubled-class rules; only the scheme choice can live in a class.
const useStyles = makeStyles({
  scheme: {
    '--floway-badge-fill': 'var(--floway-badge-fill-light)',
    '--floway-chip-stroke': 'var(--floway-badge-stroke-light)',
    '--floway-badge-label': 'var(--floway-badge-label-light)',
    '@media (prefers-color-scheme: dark)': {
      '--floway-badge-fill': 'var(--floway-badge-fill-dark)',
      '--floway-chip-stroke': 'var(--floway-badge-stroke-dark)',
      '--floway-badge-label': 'var(--floway-badge-label-dark)',
    },
  },
});

/**
 * A badge painted in an arbitrary hue. The label is resolved against the fill
 * rather than the surface under it, because the wash moves the reading by enough
 * to change the answer. Fill and stroke are fractions of the hue, so they
 * composite over whatever is beneath and follow that surface's pointer and
 * selection states on their own.
 *
 * A hue may differ by scheme -- WinUI states its own success, caution and
 * critical colours twice, because a colour that carries a meaning against white
 * is not the one that carries it against black.
 */
export const useBadgeHue = (hue: BadgeHue): { className: string; style: CSSProperties } => {
  const styles = useStyles();
  const pair = typeof hue === 'string' ? { light: hue, dark: hue } : hue;
  const fill = { light: alphaHex(pair.light, BADGE_FILL_ALPHA), dark: alphaHex(pair.dark, BADGE_FILL_ALPHA) };
  const label = (own: string, ownFill: string, surface: string) => readableTone(own, blendHex(ownFill, 1, surface));

  return {
    className: styles.scheme,
    style: {
      '--floway-badge-fill-light': fill.light,
      '--floway-badge-fill-dark': fill.dark,
      '--floway-badge-stroke-light': alphaHex(pair.light, BADGE_STROKE_ALPHA),
      '--floway-badge-stroke-dark': alphaHex(pair.dark, BADGE_STROKE_ALPHA),
      '--floway-badge-label-light': label(pair.light, fill.light, HARDEST_BADGE_SURFACE.light),
      '--floway-badge-label-dark': label(pair.dark, fill.dark, HARDEST_BADGE_SURFACE.dark),
      backgroundColor: 'var(--floway-badge-fill)',
      borderColor: 'var(--floway-chip-stroke)',
      color: 'var(--floway-badge-label)',
    } as CSSProperties,
  };
};
