import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import bundledCatalog from '../../../src/data-plane/codex/catalog/bundled.json' with { type: 'json' };

const bundled = bundledCatalog as { models: { slug: string }[] };

describe('resolveCodexCatalog', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('recognizes a spaced, capitalized Codex originator User-Agent', async () => {
    const { isCodexUserAgent } = await import('../../../src/data-plane/codex/catalog.ts');
    expect(isCodexUserAgent('Codex Desktop/0.145.0 (Mac OS 26.5.0; arm64)')).toBe(true);
  });

  it('does not classify a Codex-prefixed caller without a version', async () => {
    const { isCodexUserAgent } = await import('../../../src/data-plane/codex/catalog.ts');
    expect(isCodexUserAgent('codex-tui/not-a-version')).toBe(false);
  });

  it('fetches openai/codex tag matching the parsed version and caches in-memory', async () => {
    const fake = { models: [{ slug: 'fake-from-github' }] };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(fake), { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { resolveCodexCatalog: resolve } = await import('../../../src/data-plane/codex/catalog.ts');
    const ua = 'codex_cli_rs/0.999.0 (Mac OS 15.0; arm64)';
    const first = await resolve(ua);
    const second = await resolve(ua);
    expect(first.catalog).toEqual(fake);
    expect(first.capabilities).toEqual({ audioInput: true });
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://raw.githubusercontent.com/openai/codex/rust-v0.999.0/codex-rs/models-manager/models.json');
  });

  it('falls back to bundled on a 4xx response and still caches the negative result', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { resolveCodexCatalog: resolve } = await import('../../../src/data-plane/codex/catalog.ts');
    const ua = 'codex_exec/0.998.0 (linux; x86_64)';
    const first = await resolve(ua);
    await resolve(ua);
    expect(first.catalog.models.map(m => m.slug)).toEqual(bundled.models.map(m => m.slug));
    expect(first.capabilities).toEqual({ audioInput: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

    const { resolveCodexCatalog: resolve } = await import('../../../src/data-plane/codex/catalog.ts');
    const resolution = await resolve('codex_cli_rs/0.999.1 (Mac OS; arm64)');
    expect(resolution.capabilities).toEqual({
      audioInput: true,
      ultraReasoningLevel: { effort: 'ultra', description: 'Maximum reasoning with automatic task delegation' },
    });
  });
});
