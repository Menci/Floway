import { afterEach, describe, expect, test, vi } from 'vitest';

import { CHATGPT_CLI_VERSION, CHATGPT_ORIGINATOR, CHATGPT_USER_AGENT } from '../src/constants.ts';
import { chatgptModelContextWindow, chatgptModelUsesResponsesLite, chatgptPlanSupportsImages, chatgptRawToProviderModel, fetchChatGPTCatalog } from '../src/models.ts';
import { directFetcher, type FlagId } from '@floway-dev/provider';

const okJson = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.restoreAllMocks());

describe('fetchChatGPTCatalog', () => {
  test('calls /codex/models with auth + identity headers, returns parsed catalog from {models: [...]}', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      models: [
        { slug: 'gpt-5.4', display_name: 'GPT-5.4', visibility: 'list', context_window: 272000, max_context_window: 1000000 },
        { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', visibility: 'list', context_window: 272000, max_context_window: 272000 },
        { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', context_window: 272000, max_context_window: 1000000 },
      ],
    }));
    const catalog = await fetchChatGPTCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher });
    expect(catalog).toHaveLength(3);
    expect(catalog[0]).toEqual({ id: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000, max_context_window: 1000000 });
    expect(catalog[2]).toEqual({ id: 'codex-auto-review', display_name: 'Codex Auto Review', context_window: 272000, max_context_window: 1000000 });
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`https://chatgpt.com/backend-api/codex/models?client_version=${CHATGPT_CLI_VERSION}`);
    const headers = new Headers((init as RequestInit | undefined)?.headers);
    expect(headers.get('authorization')).toBe('Bearer at');
    expect(headers.get('chatgpt-account-id')).toBe('acc');
    expect(headers.get('originator')).toBe(CHATGPT_ORIGINATOR);
    expect(headers.get('user-agent')).toBe(CHATGPT_USER_AGENT);
    expect(headers.get('user-agent')).toBe(`codex_cli_rs/${CHATGPT_CLI_VERSION} (Mac OS 26.5.0; arm64) iTerm.app/3.6.10`);
    expect(headers.get('openai-beta')).toBeNull();
  });

  test('preserves the upstream response when catalog fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 401, headers: { 'retry-after': '30' } }));
    await expect(fetchChatGPTCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher })).rejects.toMatchObject({
      displayResponse: { status: 401, headers: [['content-type', 'text/plain;charset=UTF-8'], ['retry-after', '30']], body: '{\n  "error": "unauthorized"\n}' },
    });
  });

  test.each([0, '872000'])('rejects invalid maximum %j', async max_context_window => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      models: [{ slug: 'future-model', display_name: 'Future', context_window: 272000, max_context_window }],
    }));
    await expect(fetchChatGPTCatalog({ accessToken: 'at', accountId: null, fetcher: directFetcher })).rejects.toThrow(/max_context_window/);
  });

  test.each([undefined, null])('preserves an unspecified maximum %j', async max_context_window => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      models: [{ slug: 'future-model', display_name: 'Future', context_window: 272000, max_context_window }],
    }));
    const [raw] = await fetchChatGPTCatalog({ accessToken: 'at', accountId: null, fetcher: directFetcher });
    const model = chatgptRawToProviderModel(raw, new Set());
    expect(model.limits).toEqual({});
    expect(chatgptModelContextWindow(model)).toEqual({ context_window: 272000 });
  });

  test('carries input_modalities, supported_reasoning_levels, default_reasoning_level through to ChatGPTRawModel', async () => {
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
    const catalog = await fetchChatGPTCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher });
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

  test('parses the Responses Lite catalog flag without inferring from model names', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      models: [
        { slug: 'future-lite-model', display_name: 'Future Lite', context_window: 1, use_responses_lite: true },
        { slug: 'gpt-6-astra', display_name: 'GPT-6 Astra', context_window: 2, use_responses_lite: false },
        { slug: 'legacy-model', display_name: 'Legacy', context_window: 3 },
      ],
    }));
    const catalog = await fetchChatGPTCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher });
    expect(catalog.map(model => model.use_responses_lite)).toEqual([true, false, undefined]);
  });

  test.each(['true', null])('rejects the non-boolean catalog flag %j', async use_responses_lite => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({
      models: [{ slug: 'gpt-x', display_name: 'GPT-X', context_window: 1, use_responses_lite }],
    }));
    await expect(fetchChatGPTCatalog({ accessToken: 'at', accountId: 'acc', fetcher: directFetcher })).rejects.toThrow(/use_responses_lite not a boolean/);
  });
});

describe('chatgptRawToProviderModel', () => {
  const noFlags: ReadonlySet<FlagId> = new Set();

  test('exposes the maximum publicly and retains the default in private provider data', () => {
    const m = chatgptRawToProviderModel({ id: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000, max_context_window: 872000 }, noFlags);
    expect(m.id).toBe('gpt-5.4');
    expect(m.display_name).toBe('GPT-5.4');
    expect(m.endpoints).toEqual({ openaiResponses: {} });
    expect(m.kind).toBe('chat');
    expect(m.limits.max_context_window_tokens).toBe(872000);
    expect(chatgptModelContextWindow(m)).toEqual({ context_window: 272000, max_context_window: 872000 });
    expect(m.owned_by).toBe('openai');
  });

  test('rejects a default exceeding the declared maximum', () => {
    expect(() => chatgptRawToProviderModel({ id: 'future-model', display_name: 'Future', context_window: 872000, max_context_window: 272000 }, noFlags))
      .toThrow(/context_window exceeds max_context_window/);
  });

  test.each([undefined, {}, { contextWindow: 0 }, { contextWindow: '272000' }])('rejects missing or invalid persisted default %j', providerData => {
    const model = chatgptRawToProviderModel({ id: 'future-model', display_name: 'Future', context_window: 272000 }, noFlags);
    expect(() => chatgptModelContextWindow({ ...model, providerData })).toThrow();
  });

  test.each([undefined, {}, { unrelated: true }])('defaults missing persisted metadata to Standard: %j', providerData => {
    const model = chatgptRawToProviderModel({ id: 'gpt-6-astra', display_name: 'GPT-6 Astra', context_window: 1 }, noFlags);
    expect(chatgptModelUsesResponsesLite({ ...model, providerData })).toBe(false);
  });

  test('populates chat when raw advertises both modalities and reasoning', () => {
    const m = chatgptRawToProviderModel({
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

  test('derives default = medium when supported includes medium and default_reasoning_level absent', () => {
    const m = chatgptRawToProviderModel({
      id: 'gpt-5.5',
      display_name: 'GPT-5.5',
      context_window: 272000,
      reasoning_efforts: ['low', 'medium', 'high'],
    }, noFlags);
    expect(m.chat?.reasoning).toEqual({ effort: { supported: ['low', 'medium', 'high'], default: 'medium' } });
  });

  test('derives default = first when medium absent and default_reasoning_level absent', () => {
    const m = chatgptRawToProviderModel({
      id: 'gpt-5.5',
      display_name: 'GPT-5.5',
      context_window: 272000,
      reasoning_efforts: ['low', 'high'],
    }, noFlags);
    expect(m.chat?.reasoning).toEqual({ effort: { supported: ['low', 'high'], default: 'low' } });
  });

  test('throws when default_reasoning_effort is not in reasoning_efforts', () => {
    expect(() => chatgptRawToProviderModel({
      id: 'gpt-5.5',
      display_name: 'GPT-5.5',
      context_window: 272000,
      reasoning_efforts: ['low', 'medium'],
      default_reasoning_effort: 'high',
    }, noFlags)).toThrow(/default_reasoning_level not in supported_reasoning_levels/);
  });
});

describe('ChatGPT image capability', () => {
  test.each([
    [' FREE ', false],
    ['plus', true],
    [undefined, true],
  ])('plan %j image eligibility is %s', (planType, expected) => {
    expect(chatgptPlanSupportsImages(planType)).toBe(expected);
  });
});
