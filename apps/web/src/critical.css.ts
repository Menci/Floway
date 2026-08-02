import { gradientBackgroundCss } from './components/gradient-background.css';
import { navigationProgressCss } from './components/navigation-progress.css';
import { appLoadingCss } from './components/ui/app-loading-screen.css';
import { errorShellCss } from './components/ui/error-shell.css';
import { baseFontStack } from './font-stacks';

// What has to be true before the linked stylesheets arrive -- in dev, a
// second-and-a-bit, since global.css is served through Vite's transform. Left to
// a utility class the body margin is the user agent's 8px until then, which
// reads as a white border around the whole app.
//
// Fluent scopes its tokens to the FluentProvider element, so `<body>`, the
// loading screen and the error shell see no `--fontFamilyBase`; publishing the
// stack at the document root keeps `baseFontStack` the only copy of it.
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
  appLoadingCss,
  errorShellCss,
  navigationProgressCss,
].join('\n');
