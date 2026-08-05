import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { reactRouter } from '@react-router/dev/vite';
import MagicString from 'magic-string';
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
    const transformed = new MagicString(code);
    transformed.prepend('import Prism from "prismjs";\n');
    return {
      code: transformed.toString(),
      map: transformed.generateMap({ hires: true, includeContent: true, source: id }),
    };
  },
});

// The Worker runs at 8788 in `wrangler dev`. Vite proxies every path the Worker
// owns so the SPA can call relative URLs in both dev and prod. Anything not
// matched falls through to the Vite dev server, which serves the SPA itself.
//
// Both ends are overridable so a second checkout — another worktree, or a
// Node-target instance running beside the Worker one — can claim its own pair
// of ports without editing this file.
const wranglerOrigin = process.env.FLOWAY_DEV_GATEWAY_ORIGIN ?? 'http://127.0.0.1:8788';
const webPort = Number(process.env.FLOWAY_DEV_WEB_PORT ?? '5174');

// Restoring a position needs `mappings`, `sources` and `names`;
// `sourcesContent` is the original text, which nothing here reads. Measured
// over one build of this app: 42.53 MiB of maps, of which 34.16 MiB is
// `sourcesContent`, and the largest single map falls from 18.1 MiB to 1.3 MiB
// -- Workers Static Assets uploads every file under the client output
// directory and rejects any file over 25 MiB, so carrying the text is also
// what would eventually break the deploy. The cost is that devtools resolves a
// frame to a file and line it cannot then display.
// https://github.com/cloudflare/cloudflare-docs/blob/96f2d1edbca7d722c47e0f633f56a970750c48a0/src/content/docs/workers/platform/limits.mdx#L32-L35
const sourceMapOutput = {
  // The same id is written into the chunk and into its map, which is what lets
  // the runtime restore refuse a map built for a different revision of a chunk
  // whose content hash did not change -- a comment-only edit produces exactly
  // that pair.
  // https://github.com/rolldown/rolldown/blob/872b98ac7476eb7d5892a2913e4ba010d124c6ac/packages/rolldown/src/options/output-options.ts#L206-L215
  sourcemapDebugIds: true,
  // https://github.com/rolldown/rolldown/blob/872b98ac7476eb7d5892a2913e4ba010d124c6ac/packages/rolldown/src/options/output-options.ts#L266-L277
  sourcemapExcludeSources: true,
} as const;

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
    // The language scripts src/components/ui/prism.ts registers, which the
    // prism-components-esm plugin below rewrites into modules. The dependency
    // optimizer does not run plugin transforms, so pre-bundling them -- which
    // the scanner would do on its own for a bare specifier -- would hand the
    // browser the untransformed script and leave it to find `Prism` on the
    // window. Excluding them keeps them on the plugin pipeline in dev, as they
    // already are in the build. The list mirrors that module's imports.
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
  // The build prerenders the root route by standing up a preview server and
  // connecting to `resolvedUrls.local[0]` over a real socket:
  // https://github.com/remix-run/react-router/blob/react-router%408.3.0/packages/react-router-dev/vite/plugins/prerender.ts#L546-L573
  // The bind address and that URL have to name the same interface. Left at the
  // default they do not, because Node resolves the name differently on its two
  // sides. Vite binds `localhost` on purpose, so the server follows whatever
  // the resolver picks (https://github.com/vitejs/vite/pull/8543), and `listen`
  // resolves it with no hints
  // (https://github.com/nodejs/node/blob/v22.23.2/lib/net.js#L2192-L2196),
  // which orders `::1` first per RFC 6724. `connect` forces AI_ADDRCONFIG
  // (https://github.com/nodejs/node/blob/v22.23.2/lib/net.js#L1376-L1380),
  // which drops every IPv6 candidate on a host whose only IPv6 address sits on
  // loopback -- every default container. So the server listens on `::1` while
  // the fetch can only reach 127.0.0.1, and `resolvedUrls` names neither: Vite
  // builds it from the configured hostname rather than from the
  // `server.address()` it already holds. A GitHub runner resolves `localhost`
  // to IPv4 on both sides, which is why `verify` never sees this.
  //
  // Pinning the literal takes name resolution out of the path, so the two sides
  // agree by construction rather than by agreeing on an answer. IPv4 because it
  // is the loopback that exists everywhere -- a container with IPv6 disabled
  // still has 127.0.0.1.
  //
  // Remove this once react-router requests prerenders from the bound address
  // rather than from `resolvedUrls`:
  // https://github.com/remix-run/react-router/pull/15325
  preview: {
    host: '127.0.0.1',
  },
  // A `?worker` import is bundled by its own rolldown pass, which the client
  // environment's output options do not reach.
  // https://github.com/vitejs/vite/blob/v8.1.5/packages/vite/src/node/plugins/worker.ts#L162-L232
  worker: {
    rolldownOptions: { output: sourceMapOutput },
  },
  environments: {
    client: {
      build: {
        // The maps ship, and the chunks keep the trailing `sourceMappingURL`
        // comment that names them: the ErrorBoundary in src/root.tsx restores
        // its trace through src/lib/source-mapped-stack.ts, and the same
        // comment is what lets devtools resolve a frame on a live instance.
        // Three build checks -- scripts/check-web-monaco-lazy.ts,
        // scripts/check-web-gallery-dev-only.ts and
        // scripts/check-web-locales-split.ts -- read the same files to derive
        // chunk membership from each map's module list.
        sourcemap: true,
        rolldownOptions: {
          output: {
            ...sourceMapOutput,
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
                // Above the Fluent group: at a lower priority React's core,
                // its jsx-runtime, the scheduler and react-dom are emitted
                // into the Fluent chunk instead (read off the chunk
                // sourcemaps), which erases the cache boundary this group
                // exists to draw -- a Fluent bump would rehash React and the
                // other way round. Both chunks are shell-loaded either way, so
                // the split costs no request.
                {
                  name: 'react-runtime',
                  test: /node_modules[\\/](?:\.pnpm[\\/])?(?:react(?:-dom|-router)?@|scheduler@|react(?:-dom|-router)?[\\/]|scheduler[\\/])/,
                  priority: 40,
                },
              ],
            },
          },
        },
      },
    },
  },
});
