import {
  blend,
  converter,
  formatHex,
  modeHsv,
  modeLrgb,
  modeOklch,
  modeRgb,
  parseHex,
  useMode as registerMode,
  wcagContrast,
} from 'culori/fn';

// The tree-shakeable Culori entry has no modes until its consumer registers
// them. Keep the app's colour registry whole so every isolated entry point has
// the conversion paths used by colour utilities and hue rendering.
registerMode(modeRgb);
registerMode(modeHsv);
registerMode(modeLrgb);
registerMode(modeOklch);

export const toRgb = converter('rgb');
export const toHsv = converter('hsv');
export const toLrgb = converter('lrgb');
export const toOklch = converter('oklch');

export { blend, formatHex, parseHex, wcagContrast };
