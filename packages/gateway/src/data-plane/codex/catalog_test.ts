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
    const { catalog, capabilities } = await resolve(undefined);
    expect(catalog.models.map(m => m.slug)).toEqual(bundled.models.map(m => m.slug));
    expect(capabilities).toEqual({});
  });

  it('falls back to bundled when user-agent does not match the codex pattern', async () => {
    const { resolveCodexCatalog: resolve } = await import('./catalog.ts');
    const { catalog, capabilities } = await resolve('curl/8.7.1');
    expect(catalog.models.map(m => m.slug)).toEqual(bundled.models.map(m => m.slug));
    expect(capabilities).toEqual({});
  });

  it('fetches openai/codex tag matching the parsed version and caches in-memory', async () => {
    const fake = { models: [{ slug: 'fake-from-github' }] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(fake), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { resolveCodexCatalog: resolve } = await import('./catalog.ts');
    const ua = 'codex_cli_rs/0.999.0 (Mac OS 15.0; arm64)';
    const first = await resolve(ua);
    const second = await resolve(ua);
    expect(first.catalog).toEqual(fake);
    expect(first.capabilities).toEqual({});
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://raw.githubusercontent.com/openai/codex/rust-v0.999.0/codex-rs/models-manager/models.json');
  });

  it('parses the app-server version from the Codex Desktop originator', async () => {
    const fake = { models: [{ slug: 'desktop-version' }] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(fake), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { resolveCodexCatalog: resolve } = await import('./catalog.ts');
    const ua = 'codex_desktop/0.145.0-alpha.18 (Windows 10.0.28000; x86_64) unknown (codex_desktop; 1.2.3)';
    expect((await resolve(ua)).catalog).toEqual(fake);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://raw.githubusercontent.com/openai/codex/rust-v0.145.0-alpha.18/codex-rs/models-manager/models.json');
  });

  it('falls back to bundled on a 4xx response and still caches the negative result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { resolveCodexCatalog: resolve } = await import('./catalog.ts');
    const ua = 'codex_exec/0.998.0 (linux; x86_64)';
    const first = await resolve(ua);
    await resolve(ua);
    expect(first.catalog.models.map(m => m.slug)).toEqual(bundled.models.map(m => m.slug));
    expect(first.capabilities).toEqual({});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to bundled when fetch throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { resolveCodexCatalog: resolve } = await import('./catalog.ts');
    const { catalog, capabilities } = await resolve('codex_exec/0.997.0 (test)');
    expect(catalog.models.map(m => m.slug)).toEqual(bundled.models.map(m => m.slug));
    expect(capabilities).toEqual({});
  });

  it('derives Ultra synthesis capability only from a v2 entry in the exact client catalog', async () => {
    const fake = {
      models: [
        {
          slug: 'v1-max',
          multi_agent_version: 'v1',
          supported_reasoning_levels: [
            { effort: 'max', description: 'Maximum' },
          ],
        },
        {
          slug: 'v2-ultra',
          multi_agent_version: 'v2',
          supported_reasoning_levels: [
            { effort: 'max', description: 'Maximum' },
            { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
          ],
        },
      ],
    };
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(fake), { status: 200 })) as unknown as typeof fetch;

    const { resolveCodexCatalog: resolve } = await import('./catalog.ts');
    const resolution = await resolve('codex_cli_rs/0.999.1 (Mac OS; arm64)');
    expect(resolution.capabilities).toEqual({
      ultraReasoningLevel: { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
    });
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
