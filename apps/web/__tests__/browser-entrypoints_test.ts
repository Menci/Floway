import { isBuiltin } from 'node:module';
import { resolve } from 'node:path';

import { build, type Plugin } from 'vite';
import { expect, test } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../../..');
const webRoot = resolve(repoRoot, 'apps/web');
const packages = ['agent-setup', 'gateway', 'protocols', 'provider', 'provider-custom', 'proxy'];

const browserGuard = (): Plugin => ({
  name: 'browser-boundary-guard',
  enforce: 'pre',
  resolveId(source) {
    if (isBuiltin(source) || source.startsWith('bun:') || source.startsWith('cloudflare:')) {
      throw new Error(`Backend-only import: ${source}`);
    }
  },
});

test('browser entrypoints exclude backend modules even without tree-shaking', async () => {
  const modules = new Set<string>();
  const entryExports = new Map<string, string[]>();
  await build({
    root: webRoot,
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: [browserGuard(), {
      name: 'inspect-browser-boundaries',
      generateBundle(_options, bundle) {
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== 'chunk') continue;
          for (const id of Object.keys(chunk.modules)) modules.add(id.replaceAll('\\', '/'));
          if (chunk.isEntry) entryExports.set(chunk.name, chunk.exports);
        }
      },
    }],
    build: {
      write: false,
      minify: false,
      lib: {
        entry: Object.fromEntries(packages.map(name => [name, resolve(repoRoot, 'packages', name, 'src/browser.ts')])),
        formats: ['es'],
      },
      rolldownOptions: { treeshake: false },
    },
  });

  expect([...entryExports.keys()].sort()).toEqual([...packages].sort());
  expect(modules.size).toBeGreaterThan(packages.length);
  expect(entryExports.get('gateway')).toEqual([]);
  expect([...modules].filter(id =>
    (/\/packages\/(gateway|platform|http|provider-(azure|codex|claude-code|copilot|ollama))\//.test(id)
      && !id.endsWith('/gateway/src/browser.ts'))
    || /\/apps\/platform-(node|cloudflare)\//.test(id))).toEqual([]);
  expect([...modules].filter(id =>
    /\/proxy\/src\/(bytes|dial-error|dialer)\.ts/.test(id)
    || id.includes('/proxy/src/protocols/')
    || /\/protocols\/src\/openai-responses\/(from-result|item-id|image-generation-lifecycle|web-search-lifecycle)\.ts/.test(id)
    || /\/protocols\/src\/anthropic-messages\/(id|context-window-error)\.ts/.test(id))).toEqual([]);
});

test.each([
  ['node-builtin', 'export { readFileSync } from "node:fs";', /Backend-only import: node:fs/],
  ['gateway-runtime', 'export * from "@floway-dev/gateway/browser";', /"\.\/browser" is not exported under the conditions/],
] as const)('browser build rejects %s', async (name, source, expected) => {
  const id = `\0${name}`;
  await expect(build({
    root: webRoot,
    configFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: [browserGuard(), {
      name: 'browser-boundary-probe',
      enforce: 'pre',
      resolveId(specifier) {
        if (specifier === name || specifier.endsWith(`/${name}`)) return id;
      },
      load(moduleId) {
        if (moduleId === id) return source;
      },
    }],
    build: {
      write: false,
      lib: { entry: name, formats: ['es'] },
      rolldownOptions: { treeshake: false },
    },
  })).rejects.toThrow(expected);
});
