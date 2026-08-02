// Held apart from ./theme.ts because ./critical.css.ts also spends them and is
// evaluated at build time, where @fluentui/react-components cannot be loaded.
export const baseFontStack = "'Segoe UI Variable Web', 'Segoe UI Variable Text', 'Segoe UI Variable Display', 'Segoe UI Variable Small', 'Segoe UI', system-ui, sans-serif";

// The upstream web release has no NF-flavoured WOFF2, so every browser uses
// the bundled Maple Mono webfont before falling back to platform coding faces.
// https://github.com/subframe7536/maple-font/blob/v7.9/README.md#maple-mono-nf
export const monospaceStack = "'Maple Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
