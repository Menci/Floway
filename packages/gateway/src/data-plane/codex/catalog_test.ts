import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import bundledCatalog from './catalog/bundled.json' with { type: 'json' };

const bundled = bundledCatalog as { models: { slug: string }[] };

describe('resolveCodexCatalog', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('falls back to bundled when user-agent is missing', async () => {
    const { resolveCodexCatalog: resolve } = await import('./catalog.ts');
    const catalog = await resolve(undefined);
    expect(catalog.models.map(m => m.slug)).toEqual(bundled.models.map(m => m.slug));
  });

  it('falls back to bundled when user-agent does not match the codex pattern', async () => {
    const { resolveCodexCatalog: resolve } = await import('./catalog.ts');
    const catalog = await resolve('curl/8.7.1');
    expect(catalog.models.map(m => m.slug)).toEqual(bundled.models.map(m => m.slug));
  });

  it('fetches openai/codex tag matching the parsed version and caches in-memory', async () => {
    const fake = { models: [{ slug: 'fake-from-github' }] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(fake), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { resolveCodexCatalog: resolve } = await import('./catalog.ts');
    const ua = 'codex_cli_rs/0.999.0 (Mac OS 15.0; arm64)';
    const first = await resolve(ua);
    const second = await resolve(ua);
    expect(first).toEqual(fake);
    expect(second).toEqual(fake);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://raw.githubusercontent.com/openai/codex/rust-v0.999.0/codex-rs/models-manager/models.json');
  });

  it('falls back to bundled on a 4xx response and still caches the negative result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { resolveCodexCatalog: resolve } = await import('./catalog.ts');
    const ua = 'codex_exec/0.998.0 (linux; x86_64)';
    const first = await resolve(ua);
    await resolve(ua);
    expect(first.models.map(m => m.slug)).toEqual(bundled.models.map(m => m.slug));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to bundled when fetch throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { resolveCodexCatalog: resolve } = await import('./catalog.ts');
    const catalog = await resolve('codex_exec/0.997.0 (test)');
    expect(catalog.models.map(m => m.slug)).toEqual(bundled.models.map(m => m.slug));
  });

  it('parses prerelease versions like 1.0.52-0', async () => {
    const fake = { models: [{ slug: 'prerelease-fake' }] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(fake), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { resolveCodexCatalog: resolve } = await import('./catalog.ts');
    await resolve('codex_exec/1.0.52-0 (Mac OS; arm64)');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://raw.githubusercontent.com/openai/codex/rust-v1.0.52-0/codex-rs/models-manager/models.json');
  });
});
