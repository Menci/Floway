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

const fontOverrides = {
  fontFamilyBase: baseFontStack,
  fontFamilyMonospace: monospaceStack,
  fontSizeBase100: '10px',
  fontSizeBase200: '14px',
  fontSizeBase300: '14px',
  fontSizeBase400: '16px',
  fontSizeBase500: '18px',
  fontSizeBase600: '22px',
  lineHeightBase200: '20px',
} as const;

export const flowayLightTheme = { ...webLightTheme, ...fontOverrides };
export const flowayDarkTheme = { ...webDarkTheme, ...fontOverrides };
