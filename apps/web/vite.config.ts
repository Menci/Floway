import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { reactRouter } from '@react-router/dev/vite';
import { defineConfig, runnerImport, type Plugin } from 'vite';

import { wranglerProxiedPaths } from './gateway-paths';

// Part of the app's CSS is authored in TypeScript, because its rules spend
// values the running app spends too: the WinUI layer under src/winui
// interpolates the token names and motion durations that the same modules hand
// to Fluent, and the critical block interpolates the type stack the Fluent
// theme object is built from. Rendered straight into a `<style>` element that
// text never meets Vite's CSS pipeline -- it ships unminified, unhashed, and
// the larger of the two is re-sent in full with every HTML response.
//
// Each such module is therefore also reachable as a virtual `.css` module. The
// TypeScript is evaluated here and its string handed to Vite, which from that
// point treats it as an ordinary stylesheet: `?url` emits a hashed, minified,
// cacheable asset and yields its URL, `?inline` yields the minified text for a
// sheet that has to stay in the document.
//
// Vite performs the evaluation itself. `runnerImport` stands up a throwaway
// server environment, runs the module through the same resolver and transform
// pipeline the app is built with, and tears the environment down again, so
// there is no second toolchain to keep in agreement with this config and no
// registry that outlives the call:
// https://github.com/vitejs/vite/blob/v8.1.5/packages/vite/src/node/ssr/runnerImport.ts#L14-L48
// It is also what reports the files the module read. A virtual sheet has no
// imports of its own as far as the graph is concerned, so that list is the
// only thing connecting an edit deep in the graph to the id that has to be
// rebuilt. Nothing in these graphs may reach a module that expects a browser,
// since this runs in Node.
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
      const entry = resolve(import.meta.dirname, source.module);
      const { module, dependencies } = await runnerImport<Record<string, string>>(entry);
      // `dependencies` names everything the run read except the entry itself,
      // so the entry is added separately. Registering them makes the dev
      // server re-run this load when any of them changes, and makes the build
      // watcher treat them as inputs.
      this.addWatchFile(entry);
      for (const file of dependencies) this.addWatchFile(file);
      const css = module[source.exportName]!;
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

// Fontsource writes every static face with a WOFF source behind the WOFF2 one,
// so importing one of its stylesheets pulls a second, larger copy of each face
// into the bundle:
// https://github.com/fontsource/fontsource/blob/e50a906d3026beac81ebc47b5436c9d7c2e3a070/packages/core/src/css/face-rule.ts#L26-L44
// No browser this app is built for can ask for it. `build.target` is left at
// Vite's default `baseline-widely-available`, which at this version resolves to
// chrome111, edge111, firefox114, safari16.4 and ios16.4
// (https://github.com/vitejs/vite/blob/v8.1.5/packages/vite/src/node/constants.ts#L90-L96),
// while WOFF2 has been answered since Chrome 36, Firefox 39, Safari 10 and iOS
// 10 (https://caniuse.com/woff2).
//
// Dropping the source before `vite:css` resolves it, rather than transcribing
// the rules by hand, leaves the family, weights, subset, style and
// `font-display` upstream's to state, so no copy of them can drift from the
// installed package.
const fontsourceWoff2Only = (): Plugin => ({
  name: 'fontsource-woff2-only',
  enforce: 'pre',
  transform(code, id) {
    const path = id.split('?', 1)[0]!.replaceAll('\\', '/');
    if (!/\/@fontsource(?:-variable)?\/[^/]+\/[^/]+\.css$/.test(path)) return;
    const woff2Only = code.replaceAll(/,\s*url\([^()]+\.woff\)\s*format\(['"]?woff['"]?\)/g, '');
    // A rewrite of the rule upstream would otherwise put the fallback back
    // silently, since the strip that no longer matches anything looks the same
    // from here as a sheet that never carried one.
    if (/\.woff\b/.test(woff2Only)) throw new Error(`${path} still declares a WOFF source`);
    return woff2Only;
  },
});

// Workers Static Assets uploads every file under the configured `directory`,
// which for this app is the client build output, so the source maps below
// would ride along -- 42.4 MiB across 172 files, the largest of them within a
// factor of 1.4 of Cloudflare's 25 MiB per-file ceiling.
//
// `.assetsignore` is wrangler's exclusion list for that directory: it is read
// from the directory root, takes `.gitignore` syntax, and is itself left out
// of the upload along with the other metafiles
// (https://developers.cloudflare.com/workers/static-assets/binding/#ignoring-assets,
// implemented at
// https://github.com/cloudflare/workers-sdk/blob/wrangler%404.81.0/packages/workers-shared/utils/helpers.ts#L61-L86).
// The whole output tree is gitignored, so the file is emitted by the build
// rather than checked in.
const excludeSourceMapsFromUpload = (): Plugin => {
  let assetsIgnorePath: string;
  return {
    name: 'floway-assetsignore',
    apply: 'build',
    applyToEnvironment: environment => environment.name === 'client',
    configResolved(config) {
      // `build.outDir` is kept as authored, so it is the top-level root every
      // other consumer resolves it against.
      assetsIgnorePath = resolve(config.root, config.environments.client!.build.outDir, '.assetsignore');
    },
    closeBundle: {
      order: 'post',
      handler: () => writeFile(assetsIgnorePath, '*.js.map\n'),
    },
  };
};

// The Worker runs at 8788 in `wrangler dev`. Vite proxies every path the Worker
// owns so the SPA can call relative URLs in both dev and prod. Anything not
// matched falls through to the Vite dev server, which serves the SPA itself.
//
// Both ends are overridable so a second checkout — another worktree, or a
// Node-target instance running beside the Worker one — can claim its own pair
// of ports without editing this file.
const wranglerOrigin = process.env.FLOWAY_DEV_GATEWAY_ORIGIN ?? 'http://127.0.0.1:8788';
const webPort = Number(process.env.FLOWAY_DEV_WEB_PORT ?? '5174');

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
      'monaco-editor',
      'monaco-yaml',
      'overlayscrollbars',
      'prismjs',
      'react',
      'react-dom/client',
      'react-hook-form',
      'react-i18next',
      'react-markdown',
      'react-router',
      'react-window',
      'remark-gfm',
      'remend',
      'yaml',
      'zod',
      'zustand',
    ],
    // These six are Prism's language scripts, which the prism-components-esm
    // plugin below rewrites into modules. The dependency optimizer does not run
    // plugin transforms, so pre-bundling them -- which the scanner would do on
    // its own for a bare specifier -- would hand the browser the untransformed
    // script and leave it to find `Prism` on the window. Excluding them keeps
    // them on the plugin pipeline in dev, as they already are in the build.
    exclude: [
      'prismjs/components/prism-bash',
      'prismjs/components/prism-json',
      'prismjs/components/prism-markdown',
      'prismjs/components/prism-powershell',
      'prismjs/components/prism-toml',
      'prismjs/components/prism-typescript',
    ],
  },
  plugins: [
    excludeSourceMapsFromUpload(),
    fontsourceWoff2Only(),
    prismComponentsEsm(),
    typescriptStylesheets(),
    reactRouter(),
  ],
  // Fluent's ESM facade imports named exports from its provider packages,
  // whose `node` export condition points at CommonJS. Dev SSR must transform
  // the whole family together; externalizing the nested provider lets Node
  // select CommonJS and reject those named imports.
  // https://github.com/microsoft/fluentui/blob/4aa1084999a8c1ac7245724ad6c76210fe80acf6/packages/react-components/react-provider/package.json#L24-L30
  ssr: {
    noExternal: [/^@fluentui\//, /^@griffel\//, /^tabster(?:$|\/)/],
  },
  server: {
    port: webPort,
    proxy: Object.fromEntries(wranglerProxiedPaths.map(p => [p, { target: wranglerOrigin, changeOrigin: true }])),
  },
  environments: {
    client: {
      build: {
        // The maps are built for the two build checks that read them --
        // scripts/check-web-monaco-lazy.ts and
        // scripts/check-web-gallery-dev-only.ts derive chunk membership from
        // each map's module list, and fall back to a far weaker scan of the
        // emitted text without one. They are not deployed: the
        // `.assetsignore` plugin above keeps them out of the Workers Static
        // Assets upload. Nothing in the browser would consume them anyway --
        // the ErrorBoundary in src/root.tsx renders `error.stack` as text, and
        // a source map never reaches that string.
        sourcemap: true,
        rolldownOptions: {
          output: {
            codeSplitting: {
              groups: [
                // The charts are excluded because they are the one part of
                // Fluent this app reaches without going through
                // `@fluentui/react-components`: the two monitor routes import
                // `@fluentui/react-charts` by name, so leaving it out of the
                // group lets it and its d3 dependencies settle into a chunk
                // those routes pull in, instead of riding the shell to every
                // page. Measured against the login payload: 2298.7 -> 2111.6
                // KiB raw, 492.8 -> 445.1 KiB brotli. The two chart routes pay
                // 4.1 KiB brotli for the extra chunk boundary.
                //
                // Nothing else separates the same way while src/fluent.ts
                // imports the component barrel as a namespace, because that
                // makes every package behind the barrel reachable from the
                // root route.
                {
                  name: 'fluent',
                  test: /node_modules[\\/](?:\.pnpm[\\/])?(?:@fluentui\+(?!react-charts|chart-utilities)|@griffel\+|tabster@|@fluentui[\\/](?!react-charts|chart-utilities)|@griffel[\\/]|tabster[\\/])/,
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
