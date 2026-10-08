import { readFileSync } from 'node:fs';

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
  const factory = new Function('connections', 'fetch', 'anthropicMessagesApi', 'openAIResponsesApi', 'VERSION', body)(connections, fetchCatalog, () => ({}), () => ({}), '1.1.0') as (pi: { registerProvider: (provider: Provider) => void }) => Promise<void>;
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
  const factory = new Function('connections', 'fetch', 'anthropicMessagesApi', 'openAIResponsesApi', 'VERSION', body)(
    [{ provider: 'work', endpoint: 'https://gateway.example', apiKey: 'key' }],
    async () => Response.json({ models: [model] }), () => adapter, () => adapter, '1.1.0',
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
