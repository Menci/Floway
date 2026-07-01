import { afterEach, describe, expect, test, vi } from 'vitest';

import { CODEX_CLI_VERSION, CODEX_ORIGINATOR, CODEX_USER_AGENT } from './constants.ts';
import { codexRawToProviderModel, fetchCodexCatalog } from './models.ts';
import { resolveEffectivePricing } from '@floway-dev/protocols/common';
import { directFetcher } from '@floway-dev/provider';

const okJson = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.restoreAllMocks());

describe('fetchCodexCatalog', () => {
  test('calls /codex/models with auth + identity headers, returns parsed catalog from {models: [...]}', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      models: [
        { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', context_window: 272000, max_context_window: 1000000 },
        { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', visibility: 'list', context_window: 272000, max_context_window: 272000 },
        { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', context_window: 272000, max_context_window: 1000000 },
      ],
    }));
    const catalog = await fetchCodexCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher });
    expect(catalog).toHaveLength(3);
    expect(catalog[0]).toEqual({ id: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000 });
    expect(catalog[2]).toEqual({ id: 'codex-auto-review', display_name: 'Codex Auto Review', context_window: 272000 });
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_CLI_VERSION}`);
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    expect(headers.get('authorization')).toBe('Bearer at');
    expect(headers.get('chatgpt-account-id')).toBe('acc');
    expect(headers.get('originator')).toBe(CODEX_ORIGINATOR);
    expect(headers.get('user-agent')).toBe(CODEX_USER_AGENT);
    expect(headers.get('user-agent')).toBe(`codex_cli_rs/${CODEX_CLI_VERSION} (Mac OS 26.5.0; arm64) iTerm.app/3.6.10`);
    expect(headers.get('openai-beta')).toBeNull();
  });

  test('throws when upstream returns non-2xx (caller handles 401 retry)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401 }));
    await expect(fetchCodexCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher })).rejects.toThrow(/401/);
  });

  test('throws on missing models key (forward-compatible shape guard)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ data: [] }));
    await expect(fetchCodexCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher })).rejects.toThrow(/models array/);
  });

  test('throws on entry missing slug', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ models: [{ display_name: 'no slug here' }] }));
    await expect(fetchCodexCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher })).rejects.toThrow(/slug/);
  });

  test('throws on entry missing display_name', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ models: [{ slug: 'gpt-x', context_window: 1 }] }));
    await expect(fetchCodexCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher })).rejects.toThrow(/display_name/);
  });

  test('throws on entry missing context_window', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ models: [{ slug: 'gpt-x', display_name: 'GPT-X' }] }));
    await expect(fetchCodexCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher })).rejects.toThrow(/context_window/);
  });

  test('carries input_modalities, supported_reasoning_levels, default_reasoning_level through to CodexRawModel', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      models: [{
        slug: 'gpt-5.5',
        display_name: 'GPT-5.5',
        context_window: 272000,
        input_modalities: ['text', 'image'],
        supported_reasoning_levels: [
          { effort: 'low', description: 'Fast' },
          { effort: 'medium', description: 'Balanced' },
          { effort: 'high', description: 'Thorough' },
        ],
        default_reasoning_level: 'medium',
      }],
    }));
    const catalog = await fetchCodexCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher });
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toEqual({
      id: 'gpt-5.5',
      display_name: 'GPT-5.5',
      context_window: 272000,
      input_modalities: ['text', 'image'],
      reasoning_efforts: ['low', 'medium', 'high'],
      default_reasoning_effort: 'medium',
    });
  });

  test('tolerates entries missing the new optional fields (pre-catalog backwards compat)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      models: [{ slug: 'gpt-old', display_name: 'GPT-Old', context_window: 100000 }],
    }));
    const catalog = await fetchCodexCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher });
    expect(catalog[0]).toEqual({ id: 'gpt-old', display_name: 'GPT-Old', context_window: 100000 });
    expect(catalog[0].input_modalities).toBeUndefined();
    expect(catalog[0].reasoning_efforts).toBeUndefined();
    expect(catalog[0].default_reasoning_effort).toBeUndefined();
  });

  test('throws on malformed input_modalities entry (unknown modality)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      models: [{ slug: 'gpt-x', display_name: 'GPT-X', context_window: 1, input_modalities: ['video'] }],
    }));
    await expect(fetchCodexCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher })).rejects.toThrow(/modality/);
  });

  test('throws on malformed supported_reasoning_levels entry (missing effort)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      models: [{ slug: 'gpt-x', display_name: 'GPT-X', context_window: 1, supported_reasoning_levels: [{ description: 'no effort field' }] }],
    }));
    await expect(fetchCodexCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher })).rejects.toThrow(/reasoning level entry malformed/);
  });
});

describe('codexRawToProviderModel', () => {
  // The mapper just threads `enabledFlags` through onto the produced model;
  // these unit tests exercise the rest of the shape with the empty set, and
  // a dedicated test asserts the threading.
  const noFlags: ReadonlySet<string> = new Set();

  test('shapes raw → ProviderModel with responses-only endpoint and per-request context window', () => {
    const m = codexRawToProviderModel({ id: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000 }, noFlags);
    expect(m.id).toBe('gpt-5.4');
    expect(m.display_name).toBe('GPT-5.4');
    expect(m.endpoints).toEqual({ responses: {} });
    expect(m.kind).toBe('chat');
    expect(m.limits.max_context_window_tokens).toBe(272000);
    expect(m.owned_by).toBe('openai');
  });

  test('attaches OpenAI-API-rate cost for known slugs and treats codex-auto-review as gpt-5.4', () => {
    const flagship = codexRawToProviderModel({ id: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000 }, noFlags);
    expect(flagship.cost).toEqual({
      input: 2.5,
      input_cache_read: 0.25,
      output: 15,
      tiers: {
        flex: { input: 1.25, input_cache_read: 0.13, output: 7.5 },
        priority: { input: 5, input_cache_read: 0.5, output: 30 },
      },
    });
    const review = codexRawToProviderModel({ id: 'codex-auto-review', display_name: 'Codex Auto Review', context_window: 272000 }, noFlags);
    expect(review.cost).toEqual(flagship.cost);
  });

  // End-to-end resolution check: tier keys must match the wire-value strings
  // billableServiceTier persists, not the enum *names* in Codex's Rust source.
  // A casing typo here (e.g. `Flex`) or a divergence from the wire value (e.g.
  // `fast`) would compile cleanly against the structural test above but bill
  // every tiered request at base.
  test('cost.tiers keys resolve through resolveEffectivePricing for the wire-value strings', () => {
    const flagship = codexRawToProviderModel({ id: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000 }, noFlags);
    if (!flagship.cost) throw new Error('expected cost to be defined');

    expect(resolveEffectivePricing(flagship.cost, 'priority')).toEqual({
      input: 5,
      input_cache_read: 0.5,
      output: 30,
    });
    expect(resolveEffectivePricing(flagship.cost, 'flex')).toEqual({
      input: 1.25,
      input_cache_read: 0.13,
      output: 7.5,
    });
    expect(resolveEffectivePricing(flagship.cost, null)).toEqual({
      input: 2.5,
      input_cache_read: 0.25,
      output: 15,
    });
  });

  test('omits cost for unknown slugs (forward-compat with new upstream models)', () => {
    const m = codexRawToProviderModel({ id: 'gpt-future-unreleased', display_name: 'X', context_window: 1 }, noFlags);
    expect(m.cost).toBeUndefined();
  });

  test('threads the supplied enabledFlags onto the produced model', () => {
    const flags: ReadonlySet<string> = new Set(['responses-web-search-shim']);
    const m = codexRawToProviderModel({ id: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000 }, flags);
    expect(m.enabledFlags).toBe(flags);
  });

  test('populates chat when raw advertises both modalities and reasoning', () => {
    const m = codexRawToProviderModel({
      id: 'gpt-5.5',
      display_name: 'GPT-5.5',
      context_window: 272000,
      input_modalities: ['text', 'image'],
      reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
      default_reasoning_effort: 'medium',
    }, noFlags);
    expect(m.chat).toEqual({
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: { effort: { supported: ['low', 'medium', 'high', 'xhigh'], default: 'medium' } },
    });
  });

  test('omits chat when raw has no modalities or reasoning metadata', () => {
    const m = codexRawToProviderModel({ id: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000 }, noFlags);
    expect(m.chat).toBeUndefined();
  });

  test('sets chat.modalities but omits chat.reasoning when only modalities are present', () => {
    const m = codexRawToProviderModel({
      id: 'gpt-5.5',
      display_name: 'GPT-5.5',
      context_window: 272000,
      input_modalities: ['text'],
    }, noFlags);
    expect(m.chat).toEqual({
      modalities: { input: ['text'], output: ['text'] },
    });
    expect(m.chat?.reasoning).toBeUndefined();
  });

  test('derives default = medium when supported includes medium and default_reasoning_level absent', () => {
    const m = codexRawToProviderModel({
      id: 'gpt-5.5',
      display_name: 'GPT-5.5',
      context_window: 272000,
      reasoning_efforts: ['low', 'medium', 'high'],
    }, noFlags);
    expect(m.chat?.reasoning).toEqual({ effort: { supported: ['low', 'medium', 'high'], default: 'medium' } });
  });

  test('derives default = first when medium absent and default_reasoning_level absent', () => {
    const m = codexRawToProviderModel({
      id: 'gpt-5.5',
      display_name: 'GPT-5.5',
      context_window: 272000,
      reasoning_efforts: ['low', 'high'],
    }, noFlags);
    expect(m.chat?.reasoning).toEqual({ effort: { supported: ['low', 'high'], default: 'low' } });
  });

  test('drops reasoning entirely when default_reasoning_level present but supported_reasoning_levels absent', () => {
    const m = codexRawToProviderModel({
      id: 'gpt-5.5',
      display_name: 'GPT-5.5',
      context_window: 272000,
      default_reasoning_effort: 'medium',
    }, noFlags);
    expect(m.chat?.reasoning).toBeUndefined();
  });

  test('throws when default_reasoning_effort is not in reasoning_efforts', () => {
    expect(() => codexRawToProviderModel({
      id: 'gpt-5.5',
      display_name: 'GPT-5.5',
      context_window: 272000,
      reasoning_efforts: ['low', 'medium'],
      default_reasoning_effort: 'high',
    }, noFlags)).toThrow(/default_reasoning_level not in supported_reasoning_levels/);
  });
});
