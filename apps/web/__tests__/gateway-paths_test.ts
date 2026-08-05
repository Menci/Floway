import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse as parseJsonc } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';

import { wranglerProxiedPaths } from '../gateway-paths';
import { PUBLIC_DATA_PLANE_ROUTES } from '@floway-dev/protocols/common';

// Three hosting topologies each restate the set of paths that belong to the
// gateway, in three syntaxes, and none of them can consult the others at run
// time. `PUBLIC_DATA_PLANE_ROUTES` is the table the gateway itself registers
// from, so it is the one description that cannot be wrong; replaying it through
// each topology's own matching rules is what turns a silent divergence into a
// failing suite.
const repoRoot = resolve(import.meta.dirname, '../../..');
const readRepoFile = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8');

// Hono path parameters carry an optional inline pattern, e.g.
// `/v1beta/models/:modelAction{.+}`. A concrete sample is what the matchers
// need, and Gemini's action form is the one that puts a colon inside a segment.
const SAMPLE_SEGMENT: Record<string, string> = {
  modelAction: 'gemini-2.5-pro:generateContent',
  modelId: 'gemini-2.5-pro',
};
const concreteUrl = (path: string) =>
  path.replaceAll(/:(\w+)(?:\{.*\})?/g, (_, name: string) => {
    const sample = SAMPLE_SEGMENT[name];
    if (sample === undefined) throw new Error(`No sample segment for route parameter :${name}`);
    return sample;
  });

const gatewayUrls = [
  ...new Set(Object.values(PUBLIC_DATA_PLANE_ROUTES).flatMap(route => route.paths.map(concreteUrl))),
  // The control plane and the favicon are gateway-owned too, and no table
  // enumerates them; one representative path per mounted prefix is enough to
  // catch a topology dropping the prefix.
  '/api/upstreams',
  '/auth/login',
  '/favicon.ico',
];

// https://github.com/vitejs/vite/blob/v8.1.5/packages/vite/src/node/server/middlewares/proxy.ts
// -- a context not starting with `^` matches by prefix.
const viteProxies = (url: string) => wranglerProxiedPaths.some(context => url.startsWith(context));

// `proxy_pass` is what makes a location a gateway path; the file also carries
// locations that only settle how a static asset is served.
const nginxLocations = [
  ...readRepoFile('docker/nginx.conf').matchAll(/^\s*location\s+~\s+(\S+)\s*\{[^}]*proxy_pass[^}]*\}/gm),
].map(([, pattern]) => new RegExp(pattern!));
const nginxProxies = (url: string) => nginxLocations.some(pattern => pattern.test(url));

// Cloudflare's `run_worker_first` entries are path globs where `*` spans any
// characters, separators included:
// https://developers.cloudflare.com/workers/static-assets/routing/advanced/httprequest/
const wranglerConfig = parseJsonc(readRepoFile('wrangler.example.jsonc')) as {
  assets: { run_worker_first: string[] };
};
const wranglerGlobs = wranglerConfig.assets.run_worker_first.map(
  glob => new RegExp(`^${glob.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`).replaceAll('*', '.*')}$`),
);
const wranglerProxies = (url: string) => wranglerGlobs.some(pattern => pattern.test(url));

describe('gateway path coverage', () => {
  it('reads a non-empty list out of each topology', () => {
    expect(wranglerProxiedPaths.length).toBeGreaterThan(0);
    expect(nginxLocations.length).toBeGreaterThan(0);
    expect(wranglerGlobs.length).toBeGreaterThan(0);
  });

  it.each(gatewayUrls)('routes %s to the gateway in every topology', url => {
    expect({
      vite: viteProxies(url),
      nginx: nginxProxies(url),
      wrangler: wranglerProxies(url),
    }).toEqual({ vite: true, nginx: true, wrangler: true });
  });

  it('leaves SPA routes to the static handler in every topology', () => {
    for (const url of ['/', '/login', '/dashboard/upstreams', '/assets/root-abcdef12.js']) {
      expect({ url, vite: viteProxies(url), nginx: nginxProxies(url), wrangler: wranglerProxies(url) }).toEqual({
        url,
        vite: false,
        nginx: false,
        wrangler: false,
      });
    }
  });
});
