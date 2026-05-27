import Vue from '@vitejs/plugin-vue';
import Unocss from 'unocss/vite';
import VueRouter from 'unplugin-vue-router/vite';
import { defineConfig } from 'vite';

// The Worker runs at 8788 in `wrangler dev` for this worktree (the main repo
// claims 8787). Vite proxies every path the Worker owns so the SPA can call
// relative URLs in both dev and prod. Anything not matched falls through to
// the Vite dev server, which serves the SPA itself.
const wranglerOrigin = 'http://127.0.0.1:8788';
const wranglerProxiedPaths = ['/api', '/auth', '/v1', '/v1beta', '/embeddings', '/models'];

export default defineConfig({
  plugins: [
    VueRouter({
      dts: 'src/typed-router.d.ts',
      exclude: ['**/components/**'],
    }),
    Vue(),
    Unocss(),
  ],
  server: {
    port: 5174,
    proxy: Object.fromEntries(wranglerProxiedPaths.map(p => [p, { target: wranglerOrigin, changeOrigin: true }])),
  },
  build: {
    target: 'esnext',
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        chunkFileNames: 'assets/[hash].js',
      },
    },
  },
});
