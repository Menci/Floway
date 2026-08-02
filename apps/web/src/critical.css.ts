import { gradientBackgroundCss } from './components/gradient-background.css';
import { navigationProgressCss } from './components/navigation-progress.css';
import { errorShellCss } from './components/ui/error-shell.css';
import { loadingCss } from './components/ui/loading-screen.css';
import { baseFontStack } from './font-stacks';

// Fluent scopes its tokens to the FluentProvider element, so `<body>`, the
// loading screen and the error shell see no `--fontFamilyBase` unless it is
// published at the document root.
//
// The colour scheme is declared on the same condition ./root.tsx picks the
// Fluent theme from, and on no other: the dashboard follows the system and
// offers no override, so one query switches both the theme and the user agent
// surfaces -- scrollbars, native controls, the canvas behind the first paint.
//
// ../vite.config.ts serves this module as `virtual:floway-critical.css` and
// evaluates this graph in Node, so nothing here may reach a browser module.
const documentCss = `
html, body { height: 100%; overflow: hidden; }
body { margin: 0; }
@media (prefers-color-scheme: dark) { html { color-scheme: dark; } }
*, *::before, *::after { box-sizing: border-box; }
:root { --fontFamilyBase: ${baseFontStack}; }
body { font-family: var(--fontFamilyBase); }
`;

export const criticalCss = [
  documentCss,
  gradientBackgroundCss,
  loadingCss,
  errorShellCss,
  navigationProgressCss,
].join('\n');
