// Held apart from ./theme.ts so build-time ./critical.css.ts can spend them without loading @fluentui/react-components.
export const baseFontStack = "'Segoe UI Variable Web', 'Segoe UI Variable Text', 'Segoe UI Variable Display', 'Segoe UI Variable Small', 'Segoe UI', system-ui, sans-serif";

// The upstream web release ships no NF-flavoured WOFF2, so the stack names plain Maple Mono.
// https://github.com/subframe7536/maple-font/blob/v7.9/README.md#maple-mono-nf
export const monospaceStack = "'Maple Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
