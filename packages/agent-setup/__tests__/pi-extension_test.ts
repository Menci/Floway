import { readFileSync } from 'node:fs';
import * as zlib from 'node:zlib';

import { expect, test, vi } from 'vitest';

import { renderAgentExtension } from '../src/render-extension.ts';

// The installer harness exercises host imports and lifecycle; this test isolates serialization.
test('Pi extension source safely serializes opaque credentials and endpoint paths', () => {
  const apiKey = "key'\"\\\n</script>\u2028\u2029` ${process.exit(1)}";
  const endpoint = 'https://gateway.example/a%20path/';
  const source = renderAgentExtension({ agent: 'pi', provider: 'floway-work', endpoint, apiKey });
  const prefix = source.slice(0, source.indexOf('import '));
  const value = new Function(`${prefix}\nreturn connections;`)() as { provider: string; endpoint: string; apiKey: string }[];
  expect(value).toEqual([{ provider: 'floway-work', endpoint: 'https://gateway.example/a%20path', apiKey }]);
  expect(source).not.toContain('</script>');
  expect(source).toContain('pi/${VERSION}');
});

test('Pi extension rendering rejects non-HTTP and credential-bearing URLs', () => {
  for (const endpoint of ['file:///tmp/file', 'ftp://example.com', 'https://user:password@example.com', 'https://example.com?a=1', 'https://example.com/#fragment']) {
    expect(() => renderAgentExtension({ agent: 'pi', provider: 'floway', endpoint, apiKey: 'key' })).toThrow();
  }
});

test.each([false, true])('Pi negotiates compression for discovery and both inference bridges (Zstd: %s)', async hasZstd => {
  const model = { id: 'model', api: 'openai-responses', headers: { 'x-model-header': 'preserved' } };
  const source = renderAgentExtension({ agent: 'pi', provider: 'floway', endpoint: 'https://gateway.example', apiKey: 'key' });
  const body = source.replace(/^import .*;\n/gm, '').replace('export default async pi =>', 'return async pi =>');
  const fetchCatalog = vi.fn<(url: string, options: { headers: Record<string, string> }) => Promise<Response>>(async () => Response.json({ models: [model] }));
  const stream = vi.fn();
  const streamSimple = vi.fn();
  const factory = new Function('fetch', 'getApiProvider', 'VERSION', 'zlib', body)(fetchCatalog, () => ({ stream, streamSimple }), '1.1.0', hasZstd ? { createZstdDecompress: vi.fn() } : {});
  let provider: {
    getModels: () => typeof model[];
    stream: (model: object, context: object, options?: object) => void;
    streamSimple: (model: object, context: object, options: object) => void;
    refreshModels: (context: { allowNetwork: boolean; publish: (publication: { update: () => void }) => Promise<void> }) => Promise<void>;
  };
  await factory({ registerProvider: (value: typeof provider) => { provider = value; } });
  await provider!.refreshModels({ allowNetwork: true, publish: async publication => { publication.update(); } });
  const expected = hasZstd ? 'gzip, deflate, br, zstd' : 'gzip, deflate, br';
  for (const [, options] of fetchCatalog.mock.calls) expect(options.headers['Accept-Encoding']).toBe(expected);
  provider!.stream(model, {});
  const options = { headers: { 'aCcEpT-EnCoDiNg': 'identity', 'x-request-header': 'preserved' }, reasoning: 'high' };
  provider!.streamSimple(model, {}, options);
  expect(stream.mock.calls[0]![2]).toEqual({ headers: { 'accept-encoding': expected } });
  expect(streamSimple.mock.calls[0]![2]).toMatchObject({ headers: { 'accept-encoding': expected, 'x-request-header': 'preserved' }, reasoning: 'high' });
  expect(options.headers['aCcEpT-EnCoDiNg']).toBe('identity');
  expect(provider!.getModels()).toEqual([model]);
});

test('Pi connections keep authentication and refresh publication isolated by provider', async () => {
  const body = readFileSync(new URL('../installers/node/pi-extension.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export default async pi =>', 'return async pi =>');
  const connections = [
    { provider: 'floway-home', endpoint: 'https://home.example', apiKey: 'home-key' },
    { provider: 'floway-work', endpoint: 'https://work.example', apiKey: 'work-key' },
  ];
  const catalogs = new Map(connections.map(connection => [connection.provider, [{ id: `${connection.provider}-model`, provider: connection.provider }]]));
  const fetchCatalog = vi.fn(async (url: string, options: { headers: Record<string, string> }) => {
    const request = new URL(url);
    const connection = connections.find(value => value.provider === request.searchParams.get('provider'))!;
    expect(request.origin).toBe(connection.endpoint);
    expect(request.searchParams.get('endpoint')).toBe(connection.endpoint);
    expect(options.headers.Authorization).toBe(`Bearer ${connection.apiKey}`);
    expect(options.headers['User-Agent']).toMatch(/^pi\/1\.1\.0 \(/);
    return Response.json({ models: catalogs.get(connection.provider) });
  });
  type Provider = {
    id: string;
    getModels: () => unknown[];
    auth: { apiKey: { resolve: () => Promise<{ auth: { apiKey: string } }> } };
    refreshModels: (context: { allowNetwork: boolean; publish: (publication: { update: () => void }) => Promise<void> }) => Promise<void>;
  };
  const providers: Provider[] = [];
  const factory = new Function('connections', 'fetch', 'getApiProvider', 'VERSION', 'zlib', body)(connections, fetchCatalog, () => ({}), '1.1.0', zlib) as (pi: { registerProvider: (provider: Provider) => void }) => Promise<void>;
  await factory({ registerProvider: provider => { providers.push(provider); } });
  expect(providers.map(provider => provider.id)).toEqual(['floway-home', 'floway-work']);
  expect(await providers[0]!.auth.apiKey.resolve()).toMatchObject({ auth: { apiKey: 'home-key' } });
  expect(await providers[1]!.auth.apiKey.resolve()).toMatchObject({ auth: { apiKey: 'work-key' } });
  const workModels = providers[1]!.getModels();
  catalogs.set('floway-home', []);
  await providers[0]!.refreshModels({ allowNetwork: true, publish: async publication => { publication.update(); } });
  expect(providers[0]!.getModels()).toEqual([]);
  expect(providers[1]!.getModels()).toBe(workModels);
  expect(fetchCatalog).toHaveBeenCalledTimes(3);
});

test('Pi delegates an explicit null payload replacement to its native adapter', async () => {
  const body = readFileSync(new URL('../installers/node/pi-extension.js', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export default async pi =>', 'return async pi =>');
  const model = { id: 'alias', api: 'anthropic-messages', effortOverrides: { high: 'fast' } };
  const adapter = { streamSimple: vi.fn<(model: object, context: object, options: { onPayload: (payload: object) => unknown }) => void>() };
  const factory = new Function('connections', 'fetch', 'getApiProvider', 'VERSION', 'zlib', body)(
    [{ provider: 'work', endpoint: 'https://gateway.example', apiKey: 'key' }],
    async () => Response.json({ models: [model] }), () => adapter, '1.1.0', zlib,
  );
  let provider: { streamSimple: (model: object, context: object, options: object) => void };
  await factory({ registerProvider: (value: typeof provider) => { provider = value; } });
  const onPayload = vi.fn(() => null);
  provider!.streamSimple(model, {}, { reasoning: 'high', onPayload });
  const payload = { output_config: { effort: 'high' } };
  expect(await adapter.streamSimple.mock.calls[0]![2].onPayload(payload)).toBeNull();
  expect(onPayload).toHaveBeenCalledWith(expect.objectContaining({ output_config: { effort: 'fast' } }), model);
  expect(model.effortOverrides.high).toBe('fast');
});

test('Pi forwards server-added native metadata and API choices without a client field or API list', async () => {
  const model = {
    id: 'server-model', provider: 'openai', api: 'google-generative-ai',
    inputLimits: { images: { resize: { maxWidth: 1234, jpegQuality: 72 } } },
    promptCache: { short: 97, long: 193 },
    samplingParams: { temperature: 0.4 },
    samplingParamsByThinkingLevel: { high: { top_p: 0.8 } },
    compat: { supportsStrictMode: true, serverAddedCapability: { nested: ['unchanged'] } },
    serverAddedMetadata: { version: 2 },
  };
  const source = renderAgentExtension({ agent: 'pi', provider: 'work', endpoint: 'https://gateway.example', apiKey: 'key' });
  const body = source.replace(/^import .*;\n/gm, '').replace('export default async pi =>', 'return async pi =>');
  const stream = vi.fn();
  const streamSimple = vi.fn();
  const providers: { getModels: () => typeof model[]; stream: typeof stream; streamSimple: (model: object, context: object, options: object) => void }[] = [];
  const getApiProvider = vi.fn(() => ({ stream, streamSimple }));
  const factory = new Function('fetch', 'getApiProvider', 'VERSION', 'zlib', body)(async () => Response.json({ models: [model] }), getApiProvider, '1.1.0', zlib);
  await factory({ registerProvider: (provider: typeof providers[number]) => { providers.push(provider); } });
  const registered = providers[0]!;
  expect(registered.getModels()).toEqual([model]);
  registered.stream(registered.getModels()[0], {}, {});
  registered.streamSimple(registered.getModels()[0]!, {}, {});
  expect(getApiProvider).toHaveBeenCalledWith('google-generative-ai');
  expect(stream.mock.calls[0]![0]).toEqual(model);
  expect(streamSimple.mock.calls[0]![0]).toEqual(model);
});
