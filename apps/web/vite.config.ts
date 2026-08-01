import { createHash } from 'node:crypto';

import { reactRouter } from '@react-router/dev/vite';
import { createJiti } from 'jiti';
import { defineConfig, type Plugin } from 'vite';

// Part of the app's CSS is authored in TypeScript, because its rules spend
// values the running app spends too: the WinUI layer under src/winui
// interpolates the token names, motion durations and opt-out selector that the
// same modules hand to Fluent, and the critical block interpolates the type
// stack the Fluent theme object is built from. Rendered straight into a
// `<style>` element that text never meets Vite's CSS pipeline -- it ships
// unminified, unhashed, and the larger of the two is re-sent in full with every
// HTML response.
//
// Each such module is therefore also reachable as a virtual `.css` module. The
// TypeScript is evaluated here and its string handed to Vite, which from that
// point treats it as an ordinary stylesheet: `?url` emits a hashed, minified,
// cacheable asset and yields its URL, `?inline` yields the minified text for a
// sheet that has to stay in the document.
//
// The evaluation is jiti's rather than a second bundler's. These modules are
// pure string-building TypeScript over relative imports, which is the shape
// jiti is at its cheapest on, and the module registry it leaves behind names
// every file it read -- which is exactly the watch list the dev server needs to
// invalidate the virtual sheet when one of them changes. Nothing in these
// graphs may reach a module that expects a browser, since this runs in Node.
const virtualStylesheets = {
  'virtual:floway-critical.css': { exportName: 'criticalCss', module: './src/critical.css.ts' },
  'virtual:floway-winui.css': { exportName: 'winuiCss', module: './src/winui/index.ts' },
} as const;

// `?url` is a build-time contract: `vite:css` turns it into an emitted asset
// only while bundling, and both the asset and the CSS plugins skip the query
// otherwise. The dev server therefore serves the URL form from a path of this
// plugin's own, so that the document carries the same `<link>` in the same
// place in both modes rather than a style element in one and a link in the
// other.
const DEV_STYLESHEET_PATH = '/@floway/stylesheet/';

const typescriptStylesheets = (): Plugin => {
  const rendered = new Map<string, string>();

  const specifierOf = (id: string) => (id.startsWith('\0') ? id.slice(1) : id).split('?', 1)[0]!;
  const sourceOf = (id: string): { exportName: string; module: string } | undefined =>
    virtualStylesheets[specifierOf(id) as keyof typeof virtualStylesheets];

  return {
    name: 'floway-typescript-stylesheets',
    resolveId(id) {
      // The resolved id keeps whatever query it arrived with, so `vite:css`
      // still sees `?url` and `?inline` on an id that ends in `.css`.
      return sourceOf(id) ? `\0${id.startsWith('\0') ? id.slice(1) : id}` : undefined;
    },
    async load(id) {
      const source = sourceOf(id);
      if (!id.startsWith('\0') || !source) return;
      // A fresh registry per load is what re-evaluates the graph; jiti's
      // on-disk transform cache survives it, so the cost is the evaluation
      // alone.
      const jiti = createJiti(import.meta.filename);
      const stylesheet = await jiti.import<Record<string, string>>(source.module);
      for (const file of Object.keys(jiti.cache)) if (!file.includes('node_modules')) this.addWatchFile(file);
      const css = stylesheet[source.exportName]!;
      if (this.environment.mode !== 'dev' || !/[?&]url\b/.test(id)) return css;
      const specifier = specifierOf(id);
      rendered.set(specifier, css);
      // The query is what makes an edit visible: the module reloads, the element
      // re-renders with a new href, and the browser fetches the sheet again
      // instead of answering from its own cache. It is a hash of the sheet
      // rather than a clock, because the document is rendered twice -- once to
      // prerender and once to hydrate -- and a clock reads differently each
      // time, which is a hydration mismatch on an element React owns.
      const version = createHash('sha256').update(css).digest('hex').slice(0, 8);
      return `export default ${JSON.stringify(`${DEV_STYLESHEET_PATH}${specifier}?v=${version}`)}`;
    },
    configureServer(server) {
      server.middlewares.use(DEV_STYLESHEET_PATH, (request, response, next) => {
        const css = rendered.get(decodeURIComponent(request.url!.slice(1).split('?', 1)[0]!));
        if (css === undefined) return next();
        response.setHeader('content-type', 'text/css');
        response.end(css);
      });
    },
  };
};

// Prism ships its language components as scripts that mutate a global `Prism`
// rather than as modules. Prepending the import supplies that required binding:
// https://github.com/PrismJS/prism/blob/76dde18a575831c91491895193f56081ac08b0c5/components/prism-json.js#L1-L27
const prismComponentsEsm = (): Plugin => ({
  name: 'prism-components-esm',
  enforce: 'pre',
  transform(code, id) {
    const path = id.split('?', 1)[0]!.replaceAll('\\', '/');
    if (!/\/prismjs\/components\/prism-[^/]+\.js$/.test(path)) return;
    return `import Prism from "prismjs";\n${code}`;
  },
});

// The Worker runs at 8788 in `wrangler dev`. Vite proxies every path the Worker
// owns so the SPA can call relative URLs in both dev and prod. Anything not
// matched falls through to the Vite dev server, which serves the SPA itself.
//
// This list MUST stay in sync with the same list in two other places — drift
// is silent and only surfaces as a 404 the SPA fallback served for a real
// gateway endpoint:
//
//   - The `location ~` regexes in docker/nginx.conf (the docker-compose
//     self-host topology).
//   - `assets.run_worker_first` in wrangler.example.jsonc (the production
//     Cloudflare Workers topology, where the SPA is served from Workers
//     Static Assets and the listed paths divert to the Worker).
//
// Bare data-plane paths are listed because the gateway accepts both root and
// `/v1` forms where the upstream protocol defines them.
const wranglerOrigin = 'http://127.0.0.1:8788';
const wranglerProxiedPaths = [
  '/api',
  '/auth',
  '/favicon.ico',
  '/v1',
  '/v2',
  '/v1beta',
  '/jina',
  '/voyage',
  '/azure-api.codex',
  '/alpha/search',
  '/completions',
  '/chat/completions',
  '/responses',
  '/messages',
  '/embeddings',
  '/models',
  '/images/generations',
  '/images/edits',
];

export default defineConfig({
  // React Router discovers route modules lazily. Pre-bundle their browser
  // dependencies at startup so the first visit to a route never makes Vite
  // re-optimize and reload the already-mounted dashboard.
  optimizeDeps: {
    include: [
      '@fluentui/react-charts',
      '@fluentui/react-components',
      '@fluentui/react-icons',
      '@hookform/resolvers/zod',
      'd3-shape',
      'hono/client',
      'i18next',
      'overlayscrollbars',
      'prismjs',
      'prismjs/components/prism-bash',
      'prismjs/components/prism-json',
      'prismjs/components/prism-markdown',
      'prismjs/components/prism-powershell',
      'prismjs/components/prism-toml',
      'prismjs/components/prism-typescript',
      'react',
      'react-dom/client',
      'react-hook-form',
      'react-i18next',
      'react-markdown',
      'react-router',
      'react-window',
      'remark-gfm',
      'remend',
      'zod',
      'zustand',
    ],
  },
  plugins: [prismComponentsEsm(), typescriptStylesheets(), reactRouter()],
  // Fluent's ESM facade imports named exports from its provider packages,
  // whose `node` export condition points at CommonJS. Dev SSR must transform
  // the whole family together; externalizing the nested provider lets Node
  // select CommonJS and reject those named imports.
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-provider/package.json#L24-L30
  ssr: {
    noExternal: [/^@fluentui\//, /^@griffel\//, /^tabster(?:$|\/)/],
  },
  server: {
    port: 5174,
    proxy: Object.fromEntries(wranglerProxiedPaths.map(p => [p, { target: wranglerOrigin, changeOrigin: true }])),
  },
  environments: {
    client: {
      build: {
        // A stack trace is only worth showing if it names our own source, so the
        // maps ship with the bundle. They cost bytes a browser fetches only when
        // a devtools pane is open, and the alternative is a failure page whose
        // trace points at minified chunk names.
        sourcemap: true,
        rolldownOptions: {
          output: {
            codeSplitting: {
              groups: [
                {
                  name: 'fluent',
                  test: /node_modules[\\/](?:\.pnpm[\\/])?(?:@fluentui\+|@griffel\+|tabster@|@fluentui[\\/]|@griffel[\\/]|tabster[\\/])/,
                  priority: 30,
                },
                {
                  name: 'react-runtime',
                  test: /node_modules[\\/](?:\.pnpm[\\/])?(?:react(?:-dom|-router)?@|scheduler@|react(?:-dom|-router)?[\\/]|scheduler[\\/])/,
                  priority: 20,
                },
              ],
            },
          },
        },
      },
    },
  },
});
