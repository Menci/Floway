import { afterEach, describe, expect, test, vi } from 'vitest';

import { CODEX_CLI_VERSION, CODEX_ORIGINATOR, CODEX_USER_AGENT } from '../src/constants.ts';
import { codexImageProviderModel, codexModelUsesResponsesLite, codexPlanSupportsImages, codexRawToProviderModel, fetchCodexCatalog, type CodexRawModel } from '../src/models.ts';
import { priceRequest } from '@floway-dev/protocols/common';
import { directFetcher, type FlagId } from '@floway-dev/provider';

const okJson = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.restoreAllMocks());

test('Codex models share the upstream-bound OpenAI opaque blob scope', () => {
  const model = codexRawToProviderModel({ id: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000 }, new Set<FlagId>());
  expect(model.upstreamModelId).toBe('gpt-5.4');
  expect(model.opaqueBlobCompatibilityScope).toEqual({ bindToUpstream: true, key: 'openai' });
  expect(codexImageProviderModel(new Set<FlagId>()).opaqueBlobCompatibilityScope).toEqual({ bindToUpstream: true, key: 'openai' });
});

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

  test('keeps the stable CLI catalog operational context and private Lite capability', async () => {
    // https://github.com/openai/codex/blob/49e95cc73f4eb2999b1d14f863c009168df6122b/codex-rs/models-manager/models.json
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      models: [{
        slug: 'gpt-6-sol', display_name: 'GPT-6-Sol', context_window: 272000, max_context_window: 872000,
        supports_experimental_context: true, minimal_client_version: '0.155.0', use_responses_lite: true,
        default_reasoning_level: 'medium', input_modalities: ['text', 'image'], supports_image_detail_original: true,
        supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(effort => ({ effort })),
      }],
    }));
    const [raw] = await fetchCodexCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher });
    const model = codexRawToProviderModel(raw, new Set());
    expect(spy.mock.calls[0][0]).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.156.0');
    const headers = new Headers(spy.mock.calls[0][1]?.headers);
    expect(headers.get('user-agent')).toBe('codex_cli_rs/0.156.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10');
    expect(headers.get('version')).toBe('0.156.0');
    expect(model.limits.max_context_window_tokens).toBe(272000);
    expect(codexModelUsesResponsesLite(model)).toBe(true);
    expect(model.chat).toEqual({
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: { effort: { supported: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], default: 'medium' } },
      image_detail_original: true,
    });
  });

  test('omits the account header when the account ID is unknown', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ models: [] }));
    await fetchCodexCatalog({ accessToken: 'at', accountId: null, fetcher: directFetcher });
    const headers = new Headers((spy.mock.calls[0][1] as RequestInit).headers);
    expect(headers.get('authorization')).toBe('Bearer at');
    expect(headers.get('chatgpt-account-id')).toBeNull();
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

  test('carries supports_image_detail_original through to CodexRawModel', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      models: [
        { slug: 'gpt-img', display_name: 'GPT-Img', context_window: 1, supports_image_detail_original: true },
        { slug: 'gpt-noimg', display_name: 'GPT-NoImg', context_window: 1, supports_image_detail_original: false },
      ],
    }));
    const catalog = await fetchCodexCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher });
    expect(catalog[0].image_detail_original).toBe(true);
    expect(catalog[1].image_detail_original).toBe(false);
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
    expect(catalog[0].image_detail_original).toBeUndefined();
  });

  test('throws on non-boolean supports_image_detail_original', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      models: [{ slug: 'gpt-x', display_name: 'GPT-X', context_window: 1, supports_image_detail_original: 'yes' }],
    }));
    await expect(fetchCodexCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher })).rejects.toThrow(/supports_image_detail_original not a boolean/);
  });

  test('parses the Responses Lite catalog flag without inferring from model names', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      models: [
        { slug: 'future-lite-model', display_name: 'Future Lite', context_window: 1, use_responses_lite: true },
        { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', context_window: 2, use_responses_lite: false },
        { slug: 'legacy-model', display_name: 'Legacy', context_window: 3 },
      ],
    }));
    const catalog = await fetchCodexCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher });
    expect(catalog.map(model => model.use_responses_lite)).toEqual([true, false, undefined]);
  });

  test.each(['true', 'false', null, 0, 1, {}, []])('rejects the non-boolean catalog flag %j', async use_responses_lite => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      models: [{ slug: 'gpt-x', display_name: 'GPT-X', context_window: 1, use_responses_lite }],
    }));
    await expect(fetchCodexCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher })).rejects.toThrow(/use_responses_lite not a boolean/);
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
  const noFlags: ReadonlySet<FlagId> = new Set();

  test('shapes raw → ProviderModel with responses-only endpoint and per-request context window', () => {
    const m = codexRawToProviderModel({ id: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000 }, noFlags);
    expect(m.id).toBe('gpt-5.4');
    expect(m.display_name).toBe('GPT-5.4');
    expect(m.endpoints).toEqual({ openaiResponses: {} });
    expect(m.kind).toBe('chat');
    expect(m.limits.max_context_window_tokens).toBe(272000);
    expect(m.owned_by).toBe('openai');
  });

  test.each([true, false, undefined])('keeps catalog flag %s in opaque provider data only', use_responses_lite => {
    const model = codexRawToProviderModel({
      id: 'future-model', display_name: 'Future Model', context_window: 1, use_responses_lite,
    }, noFlags);
    expect(model.providerData).toEqual({ useResponsesLite: use_responses_lite ?? false });
    expect(codexModelUsesResponsesLite(model)).toBe(use_responses_lite ?? false);
    expect(model.endpoints).toEqual({ openaiResponses: {} });
    expect(model).not.toHaveProperty('useResponsesLite');
    expect(model).not.toHaveProperty('use_responses_lite');
  });

  test.each(['true', null, 1, {}, []])('rejects malformed raw and persisted flag %j', value => {
    const raw = { id: 'gpt-x', display_name: 'GPT-X', context_window: 1 };
    expect(() => codexRawToProviderModel({ ...raw, use_responses_lite: value } as CodexRawModel, noFlags)).toThrow(/use_responses_lite not a boolean/);
    const model = codexRawToProviderModel(raw, noFlags);
    expect(() => codexModelUsesResponsesLite({ ...model, providerData: { useResponsesLite: value } })).toThrow(/useResponsesLite is not a boolean/);
  });

  test.each([null, 'true', 1, []])('rejects malformed persisted providerData %j', providerData => {
    const model = codexRawToProviderModel({ id: 'gpt-x', display_name: 'GPT-X', context_window: 1 }, noFlags);
    expect(() => codexModelUsesResponsesLite({ ...model, providerData })).toThrow(/providerData is not an object/);
  });

  test.each([undefined, {}, { unrelated: true }])('defaults missing persisted metadata to Standard: %j', providerData => {
    const model = codexRawToProviderModel({ id: 'gpt-6-astra', display_name: 'GPT-6 Astra', context_window: 1 }, noFlags);
    expect(codexModelUsesResponsesLite({ ...model, providerData })).toBe(false);
  });

  test('attaches OpenAI-API-rate pricing for known slugs and treats codex-auto-review as gpt-5.4', () => {
    const flagship = codexRawToProviderModel({ id: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000 }, noFlags);
    expect(flagship.pricing).toEqual({
      entries: [
        { rates: { input_tokens: '0.0000025', input_cache_read_tokens: '0.00000025', output_tokens: '0.000015' } },
        { selector: { serviceTier: 'flex' }, rates: { input_tokens: '0.00000125', input_cache_read_tokens: '0.00000013', output_tokens: '0.0000075' } },
        { selector: { serviceTier: 'priority' }, rates: { input_tokens: '0.000005', input_cache_read_tokens: '0.0000005', output_tokens: '0.00003' } },
        { selector: { inputTokens: { operator: 'gt', value: 272000 } }, rates: { input_tokens: '0.000005', input_cache_read_tokens: '0.0000005', output_tokens: '0.0000225' } },
      ],
    });
    const review = codexRawToProviderModel({ id: 'codex-auto-review', display_name: 'Codex Auto Review', context_window: 272000 }, noFlags);
    expect(review.pricing).toEqual(flagship.pricing);
  });

  // End-to-end resolution check: serviceTier selectors must match the wire
  // values billableServiceTier persists, not Codex's Rust enum names.
  test('service-tier entries resolve through the wire-value strings', () => {
    const flagship = codexRawToProviderModel({ id: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000 }, noFlags);
    if (!flagship.pricing) throw new Error('expected pricing to be defined');

    expect(priceRequest(flagship.pricing, { serviceTier: 'priority', inputTokens: 0 }).rates).toEqual({
      input_tokens: '0.000005',
      input_cache_read_tokens: '0.0000005',
      output_tokens: '0.00003',
    });
    expect(priceRequest(flagship.pricing, { serviceTier: 'flex', inputTokens: 0 }).rates).toEqual({
      input_tokens: '0.00000125',
      input_cache_read_tokens: '0.00000013',
      output_tokens: '0.0000075',
    });
    expect(priceRequest(flagship.pricing, { inputTokens: 0 }).rates).toEqual({
      input_tokens: '0.0000025',
      input_cache_read_tokens: '0.00000025',
      output_tokens: '0.000015',
    });
  });

  test('omits pricing for unknown slugs (forward-compat with new upstream models)', () => {
    const m = codexRawToProviderModel({ id: 'gpt-future-unreleased', display_name: 'X', context_window: 1 }, noFlags);
    expect(m.pricing).toBeUndefined();
  });

  test('threads the supplied enabledFlags onto the produced model', () => {
    const flags: ReadonlySet<FlagId> = new Set(['openai-responses-web-search-shim']);
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
      image_detail_original: false,
      reasoning: { effort: { supported: ['low', 'medium', 'high', 'xhigh'], default: 'medium' } },
    });
  });

  // Every codex catalog entry resolves a chat block: the mapper always states
  // `image_detail_original`.
  test('always states image_detail_original even when the raw entry is otherwise bare', () => {
    const m = codexRawToProviderModel({ id: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000 }, noFlags);
    expect(m.chat).toEqual({ image_detail_original: false });
  });

  // `ModelInfo` declares `supports_image_detail_original` under `#[serde(default)]`,
  // so a catalog predating the field carries none — and the mapper must resolve
  // that unknown capability to false before the model reaches the synthesizer.
  test('reports image_detail_original: false when the upstream entry omits the field', () => {
    const m = codexRawToProviderModel({
      id: 'gpt-5.4',
      display_name: 'GPT-5.4',
      context_window: 272000,
      input_modalities: ['text'],
    }, noFlags);
    expect(m.chat).toEqual({
      modalities: { input: ['text'], output: ['text'] },
      image_detail_original: false,
    });
  });

  test('carries the upstream supports_image_detail_original through as chat.image_detail_original', () => {
    const m = codexRawToProviderModel({
      id: 'gpt-5.5',
      display_name: 'GPT-5.5',
      context_window: 272000,
      input_modalities: ['text', 'image'],
      image_detail_original: true,
    }, noFlags);
    expect(m.chat).toEqual({
      modalities: { input: ['text', 'image'], output: ['text'] },
      image_detail_original: true,
    });
  });

  // The upstream states the two facts independently: the bundled catalog at
  // packages/gateway/src/data-plane/codex/catalog/bundled.json records `gpt-5.2`
  // taking images while rejecting detail 'original', so the mapper must carry
  // each fact on its own.
  test('keeps image_detail_original independent of the modality list', () => {
    const m = codexRawToProviderModel({
      id: 'gpt-5.2',
      display_name: 'GPT-5.2',
      context_window: 272000,
      input_modalities: ['text', 'image'],
      image_detail_original: false,
    }, noFlags);
    expect(m.chat?.modalities).toEqual({ input: ['text', 'image'], output: ['text'] });
    expect(m.chat?.image_detail_original).toBe(false);
  });

  test('sets chat.modalities but omits chat.reasoning when only modalities are present', () => {
    const m = codexRawToProviderModel({
      id: 'gpt-5.5',
      display_name: 'GPT-5.5',
      context_window: 272000,
      input_modalities: ['text'],
    }, noFlags);
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

describe('Codex image capability', () => {
  test.each([
    ['free', false],
    [' FREE ', false],
    ['plus', true],
    ['team', true],
    ['unknown', true],
    [undefined, true],
  ])('plan %j image eligibility is %s', (planType, expected) => {
    expect(codexPlanSupportsImages(planType)).toBe(expected);
  });

  test('projects gpt-image-2 as a separate image model', () => {
    const flags: ReadonlySet<FlagId> = new Set();
    expect(codexImageProviderModel(flags)).toEqual({
      id: 'gpt-image-2',
      upstreamModelId: 'gpt-image-2',
      display_name: 'GPT-Image-2',
      owned_by: 'openai',
      kind: 'image',
      limits: {},
      endpoints: { openaiImagesGenerations: {}, openaiImagesEdits: {} },
      enabledFlags: flags,
      opaqueBlobCompatibilityScope: { bindToUpstream: true, key: 'openai' },
      pricing: {
        entries: [{
          rates: {
            input_tokens: '0.000005',
            input_cache_read_tokens: '0.00000125',
            input_image_tokens: '0.000008',
            output_image_tokens: '0.00003',
          },
        }],
      },
    });
  });
});
