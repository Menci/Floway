import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// Two hosting topologies serve the client build's hashed assets themselves --
// Workers Static Assets on Cloudflare, nginx in docker-compose -- and each one
// states the cache policy for them in its own syntax, with no way to consult
// the other. Both default to revalidating every asset on every page load, so a
// topology that silently loses this policy looks correct and is merely slow.
// Reading the policy back out of both files is what turns that into a failing
// suite.
const repoRoot = resolve(import.meta.dirname, '../../..');
const readRepoFile = (path: string) => readFileSync(resolve(repoRoot, path), 'utf8');

const CACHE_CONTROL = 'public, max-age=31536000, immutable';

// A `_headers` rule block opens with an unindented URL pattern and continues
// with indented `Name: value` lines:
// https://developers.cloudflare.com/workers/static-assets/headers/
const parseHeadersFile = (source: string) => {
  const rules = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const line of source.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = new Map();
      rules.set(line.trim(), current);
      continue;
    }
    const [, name, value] = /^\s*([^:]+):\s*(.*)$/.exec(line)!;
    current!.set(name!.toLowerCase(), value!.trim());
  }
  return rules;
};

// nginx blocks nest, so the block is taken by matching braces rather than by a
// regex that would stop at the inner `location ~ \.map$`.
const nginxBlock = (source: string, header: string) => {
  const start = source.indexOf(header);
  expect(start, `${header} is missing from docker/nginx.conf`).not.toBe(-1);
  let depth = 0;
  for (let index = start + header.length - 1; index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${header} is not closed in docker/nginx.conf`);
};

const headersRules = parseHeadersFile(readRepoFile('apps/web/public/_headers'));
const nginxAssets = nginxBlock(readRepoFile('docker/nginx.conf'), 'location /assets/ {');

describe('static asset caching', () => {
  it('caches the hashed asset directory for a year in every topology', () => {
    const [, nginxCacheControl] = /add_header\s+Cache-Control\s+"([^"]+)"/.exec(nginxAssets) ?? [];
    expect({
      wrangler: headersRules.get('/assets/*')?.get('cache-control'),
      nginx: nginxCacheControl,
    }).toEqual({ wrangler: CACHE_CONTROL, nginx: CACHE_CONTROL });
  });

  // index.html names the current hashes, so it is the document every deploy
  // rewrites. Both topologies leave it on their revalidating default, and a
  // rule reaching beyond /assets/ would be how that is lost.
  it('leaves the unhashed document out of the cached scope', () => {
    expect([...headersRules.keys()]).toEqual(['/assets/*']);
  });

  // The sourcemap content type is settled inside the cached block, where nginx
  // resolves the more specific regex location first; moving it back out would
  // take the cache header off every map with it.
  it('settles the sourcemap content type inside the cached block', () => {
    expect(nginxAssets).toMatch(/location\s+~\s+\\\.map\$\s*\{\s*default_type\s+application\/json;/);
  });
});
