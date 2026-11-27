import { afterEach, describe, expect, test, vi } from 'vitest';

import { CHATGPT_CLI_VERSION, CHATGPT_ORIGINATOR, CHATGPT_USER_AGENT } from '../src/constants.ts';
import { chatgptCodexModelMetadata, chatgptPlanSupportsImages, chatgptRawToUpstreamModel, fetchChatGPTCatalog } from '../src/models.ts';
import { directFetcher, type FlagId } from '@floway-dev/upstream';

const okJson = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.restoreAllMocks());

describe('fetchChatGPTCatalog', () => {
  test.each([{ supports_search_tool: 'true' }, { experimental_supported_tools: 'clock' }, { experimental_supported_tools: [''] }, { service_tiers: 'ultrafast' }, { service_tiers: [{ id: 'ultrafast' }] }, { additional_speed_tiers: [false] }])('rejects malformed capabilities %j at refresh and after persistence', async codex => {
    const model = { slug: 'm', display_name: 'M', context_window: 100 };
    await expect(fetchChatGPTCatalog({ accessToken: 'at', accountId: null, fetcher: async () => okJson({ models: [{ ...model, ...codex }] }) })).rejects.toThrow();
    const cached = chatgptRawToUpstreamModel({ ...model, id: model.slug }, new Set());
    expect(() => chatgptCodexModelMetadata({ ...cached, upstreamData: { contextWindow: 100, codex } })).toThrow();
  });

  test('keeps explicit false capabilities and an empty tool list', async () => {
    const codex = { supports_search_tool: false, experimental_supported_tools: [], default_verbosity: null };
    const [raw] = await fetchChatGPTCatalog({ accessToken: 'at', accountId: null, fetcher: async () => okJson({ models: [{ slug: 'm', display_name: 'M', context_window: 100, ...codex }] }) });
    expect(chatgptCodexModelMetadata(chatgptRawToUpstreamModel(raw!, new Set()))).toEqual({ context_window: 100, ...codex });
  });

  test('calls /codex/models with auth + identity headers, returns parsed catalog from {models: [...]}', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      models: [
        {
          slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', context_window: 272000, max_context_window: 1000000,
          input_modalities: ['text', 'image'],
          supported_reasoning_levels: [{ effort: 'low', description: 'Fast' }, { effort: 'high', description: 'Thorough' }],
          default_reasoning_level: 'high',
        },
        { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', visibility: 'list', context_window: 272000, max_context_window: 272000 },
        { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', context_window: 272000, max_context_window: 1000000 },
      ],
    }));
    const catalog = await fetchChatGPTCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher });
    expect(catalog[0]).toEqual({
      id: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000, max_context_window: 1000000,
      input_modalities: ['text', 'image'], reasoning_efforts: ['low', 'high'], default_reasoning_effort: 'high',
    });
    expect(catalog[2]).toEqual({ id: 'codex-auto-review', display_name: 'Codex Auto Review', context_window: 272000, max_context_window: 1000000 });
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`https://chatgpt.com/backend-api/codex/models?client_version=${CHATGPT_CLI_VERSION}`);
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    expect(headers.get('authorization')).toBe('Bearer at');
    expect(headers.get('chatgpt-account-id')).toBe('acc');
    expect(headers.get('originator')).toBe(CHATGPT_ORIGINATOR);
    expect(headers.get('user-agent')).toBe(CHATGPT_USER_AGENT);
  });

  test('preserves the upstream response when catalog fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401, headers: { 'retry-after': '30' } }));
    await expect(fetchChatGPTCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher })).rejects.toMatchObject({
      displayResponse: { status: 401, headers: [['content-type', 'text/plain;charset=UTF-8'], ['retry-after', '30']], body: '{\n  "error": "unauthorized"\n}' },
    });
  });

  test('preserves an unspecified maximum', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      models: [{ slug: 'future-model', display_name: 'Future', context_window: 272000, max_context_window: null }],
    }));
    const [raw] = await fetchChatGPTCatalog({ accessToken: 'at', accountId: null, fetcher: directFetcher });
    const model = chatgptRawToUpstreamModel(raw, new Set());
    expect(model.limits).toEqual({});
    expect(chatgptCodexModelMetadata(model)).toEqual({ context_window: 272000 });
  });

  test('keeps new upstream modalities without rejecting other catalog entries or advertising unsupported input', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      models: [
        { slug: 'gpt-x', display_name: 'GPT-X', context_window: 1, input_modalities: ['text', 'video', 'image', 'video', 'audio'] },
        { slug: 'gpt-old', display_name: 'GPT-Old', context_window: 1, input_modalities: ['text'] },
        { slug: 'gpt-audio', display_name: 'GPT-Audio', context_window: 1, input_modalities: ['audio'] },
        { slug: 'future', display_name: 'Future', context_window: 1, input_modalities: ['video'] },
      ],
    }));
    const catalog = await fetchChatGPTCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher });
    expect(catalog).toHaveLength(4);
    expect(catalog[0].input_modalities).toEqual(['text', 'video', 'image', 'audio']);
    const models = catalog.map(raw => chatgptRawToUpstreamModel(raw, new Set()));
    expect(models[0].chat?.modalities).toEqual({ input: ['text', 'image', 'audio'], output: ['text'] });
    expect(models[1].chat?.modalities).toEqual({ input: ['text'], output: ['text'] });
    expect(models[2].chat?.modalities).toEqual({ input: ['audio'], output: ['text'] });
    expect(models[3].chat?.modalities).toEqual({ input: [], output: ['text'] });
  });

  test.each([null, 'text', [null], [1], [true], [{}], ['']])('rejects malformed input_modalities %j', async input_modalities => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      models: [{ slug: 'gpt-x', display_name: 'GPT-X', context_window: 1, input_modalities }],
    }));
    await expect(fetchChatGPTCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher })).rejects.toThrow();
  });

});

describe('chatgptRawToUpstreamModel', () => {
  const noFlags: ReadonlySet<FlagId> = new Set();

  test('exposes the maximum publicly and retains the default in private provider data', () => {
    const m = chatgptRawToUpstreamModel({ id: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000, max_context_window: 872000 }, noFlags);
    expect(m.endpoints).toEqual({ openaiResponses: {} });
    expect(m.kind).toBe('chat');
    expect(m.limits.max_context_window_tokens).toBe(872000);
    expect(chatgptCodexModelMetadata(m)).toEqual({ context_window: 272000, max_context_window: 872000 });
  });

  test('rejects a default exceeding the declared maximum', () => {
    expect(() => chatgptRawToUpstreamModel({ id: 'future-model', display_name: 'Future', context_window: 872000, max_context_window: 272000 }, noFlags))
      .toThrow();
  });

  test('populates chat and prefers medium as the derived default when raw advertises modalities and reasoning', () => {
    const m = chatgptRawToUpstreamModel({
      id: 'gpt-5.5',
      display_name: 'GPT-5.5',
      context_window: 272000,
      input_modalities: ['text', 'image'],
      reasoning_efforts: ['low', 'medium', 'high', 'xhigh'],
    }, noFlags);
    expect(m.chat).toEqual({
      modalities: { input: ['text', 'image'], output: ['text'] },
      image_detail_original: false,
      reasoning: { effort: { supported: ['low', 'medium', 'high', 'xhigh'], default: 'medium' } },
    });
  });

  test('throws when default_reasoning_effort is not in reasoning_efforts', () => {
    expect(() => chatgptRawToUpstreamModel({
      id: 'gpt-5.5',
      display_name: 'GPT-5.5',
      context_window: 272000,
      reasoning_efforts: ['low', 'medium'],
      default_reasoning_effort: 'high',
    }, noFlags)).toThrow();
  });
});

describe('ChatGPT image capability', () => {
  test.each([
    [' FREE ', false],
    [undefined, true],
  ])('plan %j image eligibility is %s', (planType, expected) => {
    expect(chatgptPlanSupportsImages(planType)).toBe(expected);
  });
});
