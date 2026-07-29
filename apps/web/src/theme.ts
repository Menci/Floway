import { fluentComponents } from './fluent';

const { webDarkTheme, webLightTheme } = fluentComponents;

export const baseFontStack = "'Segoe UI', 'Segoe UI Web (West European)', -apple-system, BlinkMacSystemFont, system-ui, Roboto, 'Helvetica Neue', sans-serif";

// Cascadia Code is Microsoft's own coding typeface and the one Fluent surfaces
// pair with; `monospace` alone resolves to Courier on macOS, which reads
// nothing like the rest of the dashboard. The bundled variable face is named
// with the Fontsource `Variable` suffix, so locally installed Cascadia builds
// come next, then the platform coding faces.
// https://github.com/microsoft/cascadia-code/blob/2404.23/README.md#cascadia-code
// https://github.com/fontsource/font-files/blob/main/fonts/variable/cascadia-code/README.md#cascadia-code
export const monospaceStack = "'Cascadia Code Variable', 'Cascadia Code', 'Cascadia Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

const fontOverrides = {
  fontFamilyBase: baseFontStack,
  fontFamilyMonospace: monospaceStack,
  fontSizeBase100: '10px',
  fontSizeBase200: '12px',
  fontSizeBase300: '14px',
  fontSizeBase400: '16px',
  fontSizeBase500: '18px',
  fontSizeBase600: '22px',
} as const;

export const flowayLightTheme = { ...webLightTheme, ...fontOverrides };
export const flowayDarkTheme = { ...webDarkTheme, ...fontOverrides };
