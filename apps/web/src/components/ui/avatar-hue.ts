import { converter, modeOklch, modeRgb, useMode as registerMode } from 'culori/fn';

import { fluentComponents } from '../../fluent';

registerMode(modeRgb);
registerMode(modeOklch);
const toOklch = converter('oklch');
const { webLightTheme } = fluentComponents;

// Choose a chromatic Avatar color by OKLCH hue, retaining Fluent's theme palette.
// https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-avatar/library/src/components/Avatar/useAvatarStyles.styles.ts#L265-L363
const palette = [
  ['dark-red', webLightTheme.colorPaletteDarkRedBackground2],
  ['cranberry', webLightTheme.colorPaletteCranberryBackground2],
  ['red', webLightTheme.colorPaletteRedBackground2],
  ['pumpkin', webLightTheme.colorPalettePumpkinBackground2],
  ['peach', webLightTheme.colorPalettePeachBackground2],
  ['marigold', webLightTheme.colorPaletteMarigoldBackground2],
  ['gold', webLightTheme.colorPaletteGoldBackground2],
  ['brass', webLightTheme.colorPaletteBrassBackground2],
  ['forest', webLightTheme.colorPaletteForestBackground2],
  ['seafoam', webLightTheme.colorPaletteSeafoamBackground2],
  ['dark-green', webLightTheme.colorPaletteDarkGreenBackground2],
  ['light-teal', webLightTheme.colorPaletteLightTealBackground2],
  ['teal', webLightTheme.colorPaletteTealBackground2],
  ['steel', webLightTheme.colorPaletteSteelBackground2],
  ['blue', webLightTheme.colorPaletteBlueBackground2],
  ['royal-blue', webLightTheme.colorPaletteRoyalBlueBackground2],
  ['cornflower', webLightTheme.colorPaletteCornflowerBackground2],
  ['navy', webLightTheme.colorPaletteNavyBackground2],
  ['lavender', webLightTheme.colorPaletteLavenderBackground2],
  ['purple', webLightTheme.colorPalettePurpleBackground2],
  ['grape', webLightTheme.colorPaletteGrapeBackground2],
  ['lilac', webLightTheme.colorPaletteLilacBackground2],
  ['pink', webLightTheme.colorPalettePinkBackground2],
  ['magenta', webLightTheme.colorPaletteMagentaBackground2],
  ['plum', webLightTheme.colorPalettePlumBackground2],
] as const;

const colors = palette.map(([color, hex]) => {
  const hue = toOklch(hex)?.h;
  if (hue === undefined) throw new Error(`Fluent Avatar color ${color} has no hue`);
  return { color, hue };
});

export const avatarColorForHue = (hue: number): typeof colors[number]['color'] => {
  const distance = (candidate: typeof colors[number]) => Math.abs(((hue - candidate.hue + 540) % 360) - 180);
  return colors.reduce((closest, candidate) => distance(candidate) < distance(closest) ? candidate : closest).color;
};
