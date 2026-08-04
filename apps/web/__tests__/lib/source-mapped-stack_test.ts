import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { restoreStack } from '../../src/lib/source-mapped-stack';

// The fixture is a single generated line holding two statements, which is the
// shape a bundler emits and the shape that makes the column the only thing
// distinguishing two frames.
//
//   generated: `const a=1;const b=2;`
//              column 1 -> first.ts 1:1, column 11 -> second.ts 5:3
const MAP = {
  version: 3,
  file: 'chunk.js',
  // Relative to the map, which sits beside the chunk it maps -- the shape a
  // build emits, and what makes the restored path resolve above `/assets/`.
  sources: ['../../../src/first.ts', '../../../src/second.ts'],
  names: [],
  mappings: 'AAAA,UCIE',
  debugId: 'a1b2c3d4',
};

const SCRIPT = 'https://gateway.test/assets/chunk.js';
const SCRIPT_BODY = 'const a=1;const b=2;\n//# debugId=a1b2c3d4\n//# sourceMappingURL=chunk.js.map';

const respondWith = (routes: Record<string, () => Response>) => {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    const route = routes[url];
    if (!route) throw new Error(`unexpected request to ${url}`);
    return Promise.resolve(route());
  }));
};

const json = (body: unknown) =>
  () => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const script = (body = SCRIPT_BODY) =>
  () => new Response(body, { headers: { 'content-type': 'text/javascript' } });

const wholeApp = (overrides: Record<string, () => Response> = {}) =>
  respondWith({
    [SCRIPT]: script(),
    'https://gateway.test/assets/chunk.js.map': json(MAP),
    ...overrides,
  });

describe('a stack restored from the maps its chunks name', () => {
  beforeEach(() => {
    vi.stubGlobal('location', new URL('https://gateway.test/dashboard') as unknown as Location);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('names the source position a frame was minified from', async () => {
    wholeApp();
    const restored = await restoreStack([
      'Error: boom',
      `    at handler (${SCRIPT}:1:1)`,
      `    at ${SCRIPT}:1:11`,
    ].join('\n'));

    expect(restored).toBe([
      'Error: boom',
      '    at handler (/src/first.ts:1:1)',
      '    at /src/second.ts:5:3',
    ].join('\n'));
  });

  it('leaves a frame that carries no position of its own', async () => {
    wholeApp();
    const restored = await restoreStack([
      'Error: boom',
      '    at async Promise.all (index 0)',
      '    at [native code]',
      `    at handler (${SCRIPT}:1:1)`,
    ].join('\n'));

    expect(restored.split('\n').slice(1, 3)).toEqual([
      '    at async Promise.all (index 0)',
      '    at [native code]',
    ]);
  });

  it('leaves a frame belonging to some other origin, and asks it for nothing', async () => {
    wholeApp();
    const frame = '    at inject (chrome-extension://abcdef/content.js:2:9)';
    expect(await restoreStack(`Error: boom\n${frame}`)).toBe(`Error: boom\n${frame}`);
  });

  it('leaves a stack whose script declares no map', async () => {
    respondWith({ [SCRIPT]: script('const a=1;') });
    const frame = `    at handler (${SCRIPT}:1:1)`;
    expect(await restoreStack(`Error: boom\n${frame}`)).toBe(`Error: boom\n${frame}`);
  });

  it('says so when the map a chunk names was not deployed', async () => {
    // A missing asset is answered with the SPA shell rather than a 404, so the
    // status alone cannot tell this apart from a map.
    wholeApp({
      'https://gateway.test/assets/chunk.js.map': () =>
        new Response('<!DOCTYPE html>', { headers: { 'content-type': 'text/html' } }),
    });
    await expect(restoreStack(`Error: boom\n    at handler (${SCRIPT}:1:1)`))
      .rejects.toThrow('is not a source map');
  });

  it('says so when the map was built for another revision of the chunk', async () => {
    wholeApp({
      'https://gateway.test/assets/chunk.js.map': json({ ...MAP, debugId: 'stale' }),
    });
    await expect(restoreStack(`Error: boom\n    at handler (${SCRIPT}:1:1)`))
      .rejects.toThrow('another revision');
  });

  it('says so when the map cannot be fetched', async () => {
    wholeApp({
      'https://gateway.test/assets/chunk.js.map': () => new Response('', { status: 503 }),
    });
    await expect(restoreStack(`Error: boom\n    at handler (${SCRIPT}:1:1)`))
      .rejects.toThrow('responded 503');
  });

  it('leaves a frame whose position an engine did not know', async () => {
    wholeApp();
    const frame = `    at handler (${SCRIPT}:0:0)`;
    expect(await restoreStack(`Error: boom\n${frame}`)).toBe(`Error: boom\n${frame}`);
  });
});
