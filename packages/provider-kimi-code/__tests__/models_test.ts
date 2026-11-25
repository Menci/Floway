import { afterEach, expect, test, vi } from 'vitest';

import { config, rawModel, record, speedCatalog } from './fixtures.ts';
import { fetchKimiCodeProvidedModels } from '../src/models.ts';
import { priceRequest } from '@floway-dev/protocols/common';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';
import { testFetcher, withMockedFetch } from '@floway-dev/test-utils';

afterEach(() => { vi.restoreAllMocks(); });

test('the live catalog owns model capabilities, context, thinking requirement and effort', async () => {
  const upstream = record();
  await withMockedFetch(request => {
    expect(request.url).toBe('https://api.kimi.com/coding/v1/models');
    expect(request.headers.get('authorization')).toBe(`Bearer ${config.apiKey}`);
    return Response.json({ data: [rawModel(), rawModel({ id: 'optional-thinking', supports_thinking_type: 'enabled', supports_image_in: false, think_efforts: undefined }), rawModel({ id: 'no-reasoning', supports_reasoning: false })] });
  }, async () => {
    const models = await fetchKimiCodeProvidedModels(upstream, testFetcher);
    expect(models).toHaveLength(3);
    expect(models[0]).toMatchObject({
      id: 'kimi-arbitrary-model', display_name: 'Kimi A catalog model', upstreamModelId: 'arbitrary-model', kind: 'chat',
      limits: { max_context_window_tokens: 1_048_576 },
      endpoints: { openaiChatCompletions: {}, openaiResponses: {}, anthropicMessages: {} },
      chat: { modalities: { input: ['text', 'image'], output: ['text'] }, reasoning: { mandatory: true, effort: { supported: ['low', 'high', 'max'], default: 'high' } } },
    });
    expect(models[0].enabledFlags.has('vendor-kimi')).toBe(true);
    expect(models[1].chat?.reasoning).toEqual({ mandatory: false });
    expect(models[1].chat?.modalities?.input).toEqual(['text']);
    expect(models[2].chat?.reasoning).toBeUndefined();
  });
});

test('catalog failures preserve their HTTP evidence and do not synthesize models', async () => {
  const upstream = record();
  await withMockedFetch(() => new Response('invalid key', { status: 401, headers: { 'x-upstream': 'kimi' } }), async () => {
    try {
      await fetchKimiCodeProvidedModels(upstream, testFetcher);
      throw new Error('Expected catalog failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderModelsUnavailableError);
      expect((error as ProviderModelsUnavailableError).httpResponse).toMatchObject({ status: 401, body: 'invalid key' });
    }
  });
});

test('overseas region uses the overseas coding service and operator flag overrides', async () => {
  const upstream = record({ config: { ...config, region: 'overseas' }, flagOverrides: { 'vendor-kimi': false } });
  await withMockedFetch(request => {
    expect(request.url).toBe('https://api.kimi.ai/coding/v1/models');
    return Response.json({ data: [rawModel()] });
  }, async () => expect((await fetchKimiCodeProvidedModels(upstream, testFetcher))[0].enabledFlags.has('vendor-kimi')).toBe(false));
});

test.each([false, true])('the published catalog labels grouped families while preserving raw identities (reversed: %s)', async reversed => {
  const expected = [
    ['kimi-for-coding', 'Kimi K2.8 Preview', 'kimi-k2.8-preview'],
    ['kimi-for-coding-highspeed', 'Kimi K2.7 Code', 'kimi-k2.7-code'],
    ['k3', 'Kimi K3', 'kimi-k3'],
    ['k3.1-pro', 'Kimi K3.1 Pro', 'kimi-k3.1-pro'],
  ];
  const upstream = record();
  const catalog = speedCatalog();
  await withMockedFetch(() => Response.json({ data: reversed ? catalog.toReversed() : catalog }), async () => {
    const models = await fetchKimiCodeProvidedModels(upstream, testFetcher);
    expect(models).toHaveLength(expected.length);
    expect(models.map(model => [model.upstreamModelId, model.display_name, model.id])).toEqual(expect.arrayContaining(expected));
    expect(models.map(model => model.providerData)).toEqual(expect.arrayContaining([{ standardModelId: 'kimi-for-coding' }, { fastModelId: 'kimi-for-coding-highspeed' }, { standardModelId: 'k3' }, { standardModelId: 'k3.1-pro', fastModelId: 'k3.1-pro-highspeed' }]));
    expect(models.some(model => model.id === 'kimi-for-coding')).toBe(false);
    expect(priceRequest(models.find(model => model.id === 'kimi-k2.8-preview')!.pricing!, { serviceTier: 'priority' }).rates?.input_tokens).toBe('0.0000019');
    expect(models.find(model => model.id === 'kimi-k3-256k')).toBeUndefined();
    expect(priceRequest(models.find(model => model.id === 'kimi-k3')!.pricing!, {}).rates?.input_tokens).toBe('0.000003');
    expect(priceRequest(models.find(model => model.id === 'kimi-k3')!.pricing!, { serviceTier: 'priority' }).rates?.output_tokens).toBe('0.00003');
    expect(priceRequest(models.find(model => model.id === 'kimi-k3.1-pro')!.pricing!, { serviceTier: 'priority' }).rates?.output_tokens).toBe('0.00002');
    expect(priceRequest(models.find(model => model.id === 'kimi-k2.7-code')!.pricing!, { serviceTier: 'fast' }).rates?.input_tokens).toBe('0.0000019');
  });
});

test('a same-version lane inherits its base presentation and intersects context and modalities regardless of catalog order', async () => {
  const upstream = record();
  await withMockedFetch(() => Response.json({
    data: [
      rawModel({ id: 'kimi-for-coding-highspeed', display_name: 'K9.9 Code Highspeed', context_length: 262_144, supports_image_in: false }),
      rawModel({ id: 'kimi-for-coding', display_name: 'K9.9 Code' }),
    ],
  }), async () => {
    const models = await fetchKimiCodeProvidedModels(upstream, testFetcher);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'kimi-k9.9-code', display_name: 'Kimi K9.9 Code', upstreamModelId: 'kimi-for-coding',
      providerData: { standardModelId: 'kimi-for-coding', fastModelId: 'kimi-for-coding-highspeed' },
      limits: { max_context_window_tokens: 262_144 }, chat: { modalities: { input: ['text'], output: ['text'] } },
    });
  });
});

test('an unparseable coding alias is skipped without hiding other catalog rows', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const upstream = record();
  await withMockedFetch(() => Response.json({ data: [rawModel({ id: 'kimi-for-coding', display_name: 'a name with no version' }), rawModel({ id: 'unrelated', display_name: 'another name without a version' })] }), async () => {
    const models = await fetchKimiCodeProvidedModels(upstream, testFetcher);
    expect(models.map(model => [model.id, model.upstreamModelId])).toEqual([['kimi-unrelated', 'unrelated']]);
  });
});

test('unrecognized identity cannot merge conflicting raw rows into one public family', async () => {
  const upstream = record();
  await withMockedFetch(() => Response.json({ data: [rawModel({ id: 'unknown', display_name: 'Unknown' }), rawModel({ id: 'unknown-highspeed', display_name: 'Unknown Highspeed' })] }), async () => {
    await expect(fetchKimiCodeProvidedModels(upstream, testFetcher)).rejects.toMatchObject({ name: 'ProviderModelsUnavailableError', cause: new TypeError('Kimi Code catalog contains conflicting model families: kimi-unknown') });
  });
});
