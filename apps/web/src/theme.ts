import { fluentComponents } from './fluent';

const { webDarkTheme, webLightTheme } = fluentComponents;

export const baseFontStack = "'Segoe UI Variable Web', 'Segoe UI Variable Text', 'Segoe UI Variable Display', 'Segoe UI Variable Small', 'Segoe UI', system-ui, sans-serif";

// The upstream web release has no NF-flavoured WOFF2, so every browser uses
// the bundled Maple Mono webfont before falling back to platform coding faces.
// https://github.com/subframe7536/maple-font/blob/v7.9/README.md#maple-mono-nf
export const monospaceStack = "'Maple Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// Fluent scopes its tokens to the FluentProvider element, so anything rendered
// outside it — `<body>`, the loading screen, the error shell — sees no
// `--fontFamilyBase` at all. Publishing the stack at the document root and
// applying it to the body puts every surface on one typeface while
// `baseFontStack` stays the only copy of it.
export const fontFamilyCriticalCss = `:root { --fontFamilyBase: ${baseFontStack}; } body { font-family: var(--fontFamilyBase); }`;

// The 200 step is Fluent's own 12/16 rather than the 14/20 this file carried in
// from the previous dashboard. At 14/20 it was byte-identical to the 300 step,
// so every caller that asked for the smaller size got the body size instead and
// the distinction meant nothing. WinUI states the same pair for its caption --
// the size a secondary line under a heading is set in.
// https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/typography
const fontOverrides = {
  fontFamilyBase: baseFontStack,
  fontFamilyMonospace: monospaceStack,
  fontSizeBase100: '10px',
  fontSizeBase200: '12px',
  fontSizeBase300: '14px',
  fontSizeBase400: '16px',
  fontSizeBase500: '18px',
  fontSizeBase600: '22px',
  lineHeightBase200: '16px',
} as const;

export const flowayLightTheme = { ...webLightTheme, ...fontOverrides };
export const flowayDarkTheme = { ...webDarkTheme, ...fontOverrides };
