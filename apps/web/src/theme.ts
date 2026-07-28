import type { BrandVariants } from '@fluentui/react-components';

import { fluentComponents } from './fluent';

const { createDarkTheme, createLightTheme, webDarkTheme, webLightTheme } = fluentComponents;

export const australianBrand: BrandVariants = {
  10: '#06112e',
  20: '#0b1d50',
  30: '#102a72',
  40: '#173895',
  50: '#1d47b8',
  60: '#2358d7',
  70: '#2770ea',
  80: '#4385f0',
  90: '#6199f4',
  100: '#7eacf7',
  110: '#9abefa',
  120: '#b5d0fc',
  130: '#cde0fd',
  140: '#dfebfe',
  150: '#eef5ff',
  160: '#f7faff',
};

// Cascadia Code is Microsoft's own coding typeface and the one Fluent surfaces
// pair with; `monospace` alone resolves to Courier on macOS, which reads
// nothing like the rest of the dashboard. The bundled variable face is named
// with the Fontsource `Variable` suffix, so locally installed Cascadia builds
// come next, then the platform coding faces.
// https://github.com/microsoft/cascadia-code/blob/2404.23/README.md#cascadia-code
// https://github.com/fontsource/font-files/blob/main/fonts/variable/cascadia-code/README.md#cascadia-code
const monospaceStack = "'Cascadia Code Variable', 'Cascadia Code', 'Cascadia Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const fontOverrides = {
  fontFamilyMonospace: monospaceStack,
  fontSizeBase100: '10px',
  fontSizeBase200: '12px',
  fontSizeBase300: '14px',
  fontSizeBase400: '16px',
  fontSizeBase500: '18px',
  fontSizeBase600: '22px',
} as const;

export const australianLightTheme = { ...createLightTheme(australianBrand), ...fontOverrides };
export const australianDarkTheme = { ...createDarkTheme(australianBrand), ...fontOverrides };

export const flowayLightTheme = { ...webLightTheme, ...fontOverrides };
export const flowayDarkTheme = { ...webDarkTheme, ...fontOverrides };
