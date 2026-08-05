import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { restoreStack } from '../../src/lib/source-mapped-stack';

// The fixture is a single generated line, which is the shape a bundler emits
// and the shape that makes the column the only thing distinguishing two frames.
// Its two segments are adjacent -- generated columns 0 and 1 -- so a query off
// by one column lands on the wrong one. That is the only arrangement that can
// see the shift the module applies on the way in: a nearest-preceding-segment
// search absorbs the error everywhere else.
//
//   generated column 0 -> first.ts 1:1
//   generated column 1 -> second.ts 5:3
const MAP = {
  version: 3,
  file: 'chunk.js',
  // Relative to the map, which sits beside the chunk it maps -- the shape a
  // build emits, and what makes the restored path resolve above `/assets/`.
  sources: ['../../../src/first.ts', '../../../src/second.ts'],
  names: [],
  mappings: 'AAAA,CCIE',
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
      `    at ${SCRIPT}:1:2`,
    ].join('\n'));

    expect(restored).toBe([
      'Error: boom',
      '    at handler (/src/first.ts:1:1)',
      '    at /src/second.ts:5:3',
    ].join('\n'));
  });

  it('restores a SpiderMonkey or JavaScriptCore frame', async () => {
    wholeApp();
    expect(await restoreStack(`Error: boom\nhandler@${SCRIPT}:1:1`))
      .toBe('Error: boom\nhandler@/src/first.ts:1:1');
  });

  it('does not treat a URL position in the error message as a frame', async () => {
    wholeApp();
    const message = 'Error: request failed at https://gateway.test/reported:1:1';
    expect(await restoreStack(`${message}\n    at handler (${SCRIPT}:1:1)`))
      .toBe(`${message}\n    at handler (/src/first.ts:1:1)`);
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

  it('leaves an oversized frame unparsed, and asks it for nothing', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const frame = `    at ${'nested.'.repeat(170)}handler (${SCRIPT}:1:1)`;
    expect(await restoreStack(`Error: boom\n${frame}`)).toBe(`Error: boom\n${frame}`);
    expect(fetch).not.toHaveBeenCalled();
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

  it('says so when a chunk names an index map', async () => {
    wholeApp({
      'https://gateway.test/assets/chunk.js.map': json({ version: 3, sections: [] }),
    });
    await expect(restoreStack(`Error: boom\n    at handler (${SCRIPT}:1:1)`))
      .rejects.toThrow('is an index map');
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

  it('says so when the chunk cannot be fetched', async () => {
    respondWith({ [SCRIPT]: () => new Response('', { status: 503 }) });
    await expect(restoreStack(`Error: boom\n    at handler (${SCRIPT}:1:1)`))
      .rejects.toThrow(`${SCRIPT} responded 503`);
  });

  // An engine writes 0 where it has no information, and each half of the guard
  // stands alone: `originalPositionFor` throws on a line below 1, and on the
  // column the shift is what turns a reported 0 into an out-of-range -1.
  it('leaves a frame whose line an engine did not know', async () => {
    wholeApp();
    const frame = `    at handler (${SCRIPT}:0:1)`;
    expect(await restoreStack(`Error: boom\n${frame}`)).toBe(`Error: boom\n${frame}`);
  });

  it('leaves a frame whose column an engine did not know', async () => {
    wholeApp();
    const frame = `    at handler (${SCRIPT}:1:0)`;
    expect(await restoreStack(`Error: boom\n${frame}`)).toBe(`Error: boom\n${frame}`);
  });
});
