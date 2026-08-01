import { gradientBackgroundCss } from './components/gradient-background.css';
import { navigationProgressCss } from './components/navigation-progress.css';
import { appLoadingCss } from './components/ui/app-loading-screen.css';
import { errorShellCss } from './components/ui/error-shell.css';
import { baseFontStack } from './font-stacks';

// What has to be true before the linked stylesheets arrive. In dev that is a
// second-and-a-bit: global.css is served through Vite's transform while this
// block is part of the document, so anything the first paint depends on has to
// be here rather than in a utility class. The body's own margin is the clearest
// case -- left to a utility it is the user agent's 8px until the stylesheet
// lands, which reads as a white border around the whole app.
//
// The colour scheme is declared on the same condition ../root.tsx picks the
// Fluent theme from, and on no other: the dashboard follows the system and
// offers no override, so one query switches both the theme and the user agent
// surfaces -- scrollbars, native controls, the canvas behind the first paint.
//
// Fluent scopes its tokens to the FluentProvider element, so anything rendered
// outside it -- `<body>`, the loading screen, the error shell -- sees no
// `--fontFamilyBase` at all. Publishing the stack at the document root and
// applying it to the body puts every surface on one typeface while
// `baseFontStack` stays the only copy of it.
//
// ../vite.config.ts serves this module as `virtual:floway-critical.css`, which
// is how the text ../root.tsx inlines gets minified. Nothing here may reach a
// module that runs in the browser: that build step evaluates this graph in
// Node.
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
