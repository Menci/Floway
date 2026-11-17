import { converter } from 'culori/fn';
import { expect, test } from 'vitest';

import { avatarColorForHue } from '../../../src/components/ui/avatar-hue';
import { fluentComponents } from '../../../src/fluent';

const toOklch = converter('oklch');
const { webLightTheme } = fluentComponents;

test('selects the matching native palette at its exact hue', () => {
  for (const [name, hex] of [
    ['blue', webLightTheme.colorPaletteBlueBackground2],
    ['forest', webLightTheme.colorPaletteForestBackground2],
    ['pink', webLightTheme.colorPalettePinkBackground2],
    ['pumpkin', webLightTheme.colorPalettePumpkinBackground2],
  ] as const) {
    expect(avatarColorForHue(toOklch(hex)!.h!)).toBe(name);
  }
});
