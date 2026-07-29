import { fluentComponents } from './fluent';

const { webDarkTheme, webLightTheme } = fluentComponents;

export const baseFontStack = "'Segoe UI', 'Segoe UI Web (West European)', -apple-system, BlinkMacSystemFont, system-ui, Roboto, 'Helvetica Neue', sans-serif";

// The upstream web release has no NF-flavoured WOFF2, so every browser uses
// the bundled Maple Mono webfont before falling back to platform coding faces.
// https://github.com/subframe7536/maple-font/blob/v7.9/README.md#maple-mono-nf
export const monospaceStack = "'Maple Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

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
