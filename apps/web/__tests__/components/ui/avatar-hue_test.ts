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

test('treats hue as circular and uses stable native color names over the full range', () => {
  expect(avatarColorForHue(0)).toBe(avatarColorForHue(360));
  for (let hue = 0; hue < 360; hue++) {
    const color = avatarColorForHue(hue);
    expect(color).toBe(avatarColorForHue(hue));
    expect(color).not.toMatch(/neutral|brand|colorful/);
  }
});
