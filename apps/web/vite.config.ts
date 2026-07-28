import { reactRouter } from '@react-router/dev/vite';
import UnoCSS from 'unocss/vite';
import { defineConfig, type Plugin } from 'vite';

// Prism ships its language components as scripts that mutate a global `Prism`
// rather than as modules. Prepending the import supplies that required binding:
// https://github.com/PrismJS/prism/blob/76dde18a575831c91491895193f56081ac08b0c5/components/prism-json.js#L1-L27
const prismComponentsEsm = (): Plugin => ({
  name: 'prism-components-esm',
  enforce: 'pre',
  transform(code, id) {
    const path = id.split('?', 1)[0]?.replaceAll('\\', '/');
    if (!path || !/\/prismjs\/components\/prism-[^/]+\.js$/.test(path)) return;
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
  plugins: [prismComponentsEsm(), UnoCSS({ mode: 'per-module' }), reactRouter()],
  server: {
    port: 5174,
    proxy: Object.fromEntries(wranglerProxiedPaths.map(p => [p, { target: wranglerOrigin, changeOrigin: true }])),
  },
  environments: {
    client: {
      build: {
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
                {
                  name: 'vendor',
                  test: /node_modules/,
                  priority: 10,
                },
                {
                  name: 'app',
                  test: /[\\/]src[\\/]/,
                  priority: 5,
                },
              ],
            },
          },
        },
      },
    },
  },
});
