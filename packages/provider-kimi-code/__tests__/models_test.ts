import { afterEach, expect, test, vi } from 'vitest';

import { config, rawModel, record, speedCatalog } from './fixtures.ts';
import { createKimiCodeProvider } from '../src/provider.ts';
import { priceRequest } from '@floway-dev/protocols/common';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';
import { testFetcher, withMockedFetch } from '@floway-dev/test-utils';

afterEach(() => { vi.restoreAllMocks(); });

test('the live catalog owns model capabilities, context, thinking requirement and effort', async () => {
  const provider = createKimiCodeProvider(record());
  await withMockedFetch(request => {
    expect(request.url).toBe('https://api.kimi.com/coding/v1/models');
    expect(request.headers.get('authorization')).toBe(`Bearer ${config.apiKey}`);
    return Response.json({ data: [rawModel(), rawModel({ id: 'optional-thinking', supports_thinking_type: 'enabled', supports_image_in: false, think_efforts: undefined }), rawModel({ id: 'no-reasoning', supports_reasoning: false })] });
  }, async () => {
    const models = await provider.instance.getProvidedModels(testFetcher);
    expect(models).toHaveLength(3);
    expect(models[0]).toMatchObject({
      id: 'kimi-arbitrary-model', display_name: 'Kimi A catalog model', upstreamModelId: 'arbitrary-model', kind: 'chat',
      limits: { max_context_window_tokens: 1_048_576 },
      endpoints: { openaiChatCompletions: {}, openaiResponses: {}, anthropicMessages: {} },
      chat: { modalities: { input: ['text', 'image'], output: ['text'] }, reasoning: { mandatory: true, effort: { supported: ['low', 'high', 'max'], default: 'high' } } },
    });
    expect(Object.keys(models[0].endpoints)).toHaveLength(3);
    expect(models[0].pricing).toBeUndefined();
    expect(models[0].enabledFlags.has('vendor-kimi')).toBe(true);
    expect(models[1].chat?.reasoning).toEqual({ mandatory: false });
    expect(models[1].chat?.modalities?.input).toEqual(['text']);
    expect(models[2].chat?.reasoning).toBeUndefined();
  });
});

test('catalog failures preserve their HTTP evidence and do not synthesize models', async () => {
  const provider = createKimiCodeProvider(record());
  await withMockedFetch(() => new Response('invalid key', { status: 401, headers: { 'x-upstream': 'kimi' } }), async () => {
    try {
      await provider.instance.getProvidedModels(testFetcher);
      throw new Error('Expected catalog failure');
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderModelsUnavailableError);
      expect((error as ProviderModelsUnavailableError).httpResponse).toMatchObject({ status: 401, body: 'invalid key' });
    }
  });
});

test('overseas region uses the overseas coding service and operator flag overrides', async () => {
  const provider = createKimiCodeProvider(record({ config: { ...config, region: 'overseas' }, flagOverrides: { 'vendor-kimi': false } }));
  await withMockedFetch(request => {
    expect(request.url).toBe('https://api.kimi.ai/coding/v1/models');
    return Response.json({ data: [rawModel()] });
  }, async () => expect((await provider.instance.getProvidedModels(testFetcher))[0].enabledFlags.has('vendor-kimi')).toBe(false));
});

test('malformed catalog metadata fails through the shared model-discovery error envelope', async () => {
  const provider = createKimiCodeProvider(record());
  await withMockedFetch(() => Response.json({ data: [rawModel({ think_efforts: { support: true, valid_efforts: ['high'], default_effort: 'unadvertised' } })] }), async () => {
    await expect(provider.instance.getProvidedModels(testFetcher)).rejects.toMatchObject({ name: 'ProviderModelsUnavailableError', cause: expect.any(TypeError) });
  });
});

test.each([false, true])('the published catalog labels grouped families while preserving raw identities (reversed: %s)', async reversed => {
  const expected = [
    ['kimi-for-coding', 'Kimi K2.8 Preview', 'kimi-k2.8-preview'],
    ['kimi-for-coding-highspeed', 'Kimi K2.7 Code', 'kimi-k2.7-code'],
    ['k3', 'Kimi K3', 'kimi-k3'],
    ['k3.1-pro', 'Kimi K3.1 Pro', 'kimi-k3.1-pro'],
  ];
  const provider = createKimiCodeProvider(record());
  const catalog = speedCatalog();
  await withMockedFetch(() => Response.json({ data: reversed ? catalog.toReversed() : catalog }), async () => {
    const models = await provider.instance.getProvidedModels(testFetcher);
    expect(models).toHaveLength(expected.length);
    expect(models.map(model => [model.upstreamModelId, model.display_name, model.id])).toEqual(expect.arrayContaining(expected));
    expect(models.map(model => model.providerData)).toEqual(expect.arrayContaining([{ standardModelId: 'kimi-for-coding' }, { fastModelId: 'kimi-for-coding-highspeed' }, { standardModelId: 'k3' }, { standardModelId: 'k3.1-pro', fastModelId: 'k3.1-pro-highspeed' }]));
    expect(models.some(model => model.id === 'kimi-for-coding')).toBe(false);
    expect(models.find(model => model.id === 'kimi-k2.8-preview')?.pricing).toBeUndefined();
    expect(models.find(model => model.id === 'kimi-k3-256k')).toBeUndefined();
    expect(priceRequest(models.find(model => model.id === 'kimi-k3')!.pricing!, {}).rates?.input_tokens).toBe('0.000003');
    expect(priceRequest(models.find(model => model.id === 'kimi-k3.1-pro')!.pricing!, { serviceTier: 'priority' }).rates?.output_tokens).toBe('0.00002');
    expect(priceRequest(models.find(model => model.id === 'kimi-k2.7-code')!.pricing!, { serviceTier: 'fast' }).rates?.input_tokens).toBe('0.0000019');
  });
});

test('a same-version lane inherits its base presentation and intersects context and modalities regardless of catalog order', async () => {
  const provider = createKimiCodeProvider(record());
  await withMockedFetch(() => Response.json({
    data: [
      rawModel({ id: 'kimi-for-coding-highspeed', display_name: 'K9.9 Code Highspeed', context_length: 262_144, supports_image_in: false }),
      rawModel({ id: 'kimi-for-coding', display_name: 'K9.9 Code' }),
    ],
  }), async () => {
    const models = await provider.instance.getProvidedModels(testFetcher);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'kimi-k9.9-code', display_name: 'Kimi K9.9 Code', upstreamModelId: 'kimi-for-coding',
      providerData: { standardModelId: 'kimi-for-coding', fastModelId: 'kimi-for-coding-highspeed' },
      limits: { max_context_window_tokens: 262_144 }, chat: { modalities: { input: ['text'], output: ['text'] } },
    });
  });
});

test('a highspeed row without a real base becomes a fast-only family', async () => {
  const provider = createKimiCodeProvider(record());
  await withMockedFetch(() => Response.json({ data: [rawModel({ id: 'k9.9-highspeed', display_name: 'K9.9 Highspeed' })] }), async () => {
    const models = await provider.instance.getProvidedModels(testFetcher);
    expect(models.map(model => model.id)).toEqual(['kimi-k9.9']);
    expect(models.map(model => model.providerData)).toEqual([{ fastModelId: 'k9.9-highspeed' }]);
  });
});

test('derived context-capped ids are withheld across catalog families', async () => {
  const provider = createKimiCodeProvider(record());
  const catalog = [
    rawModel({ id: 'k9.9-future', display_name: 'K9.9' }),
    rawModel({ id: 'k9.9-future-256k', display_name: 'K9.9-256k' }),
  ];
  await withMockedFetch(() => Response.json({ data: catalog }), async () => {
    const models = await provider.instance.getProvidedModels(testFetcher);
    expect(models.map(model => model.id)).toEqual(['kimi-k9.9-future']);
  });
});

test('an unparseable coding alias is logged and skipped without hiding other catalog rows', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const provider = createKimiCodeProvider(record());
  await withMockedFetch(() => Response.json({ data: [rawModel({ id: 'kimi-for-coding', display_name: 'a name with no version' }), rawModel({ id: 'unrelated', display_name: 'another name without a version' })] }), async () => {
    const models = await provider.instance.getProvidedModels(testFetcher);
    expect(models.map(model => [model.id, model.upstreamModelId])).toEqual([['kimi-unrelated', 'unrelated']]);
    expect(warn).toHaveBeenCalledWith('Skipping Kimi Code model with an unrecognized display name:', 'kimi-for-coding', 'a name with no version');
  });
});

test('integer-version models can acquire a real accelerated sibling', async () => {
  const provider = createKimiCodeProvider(record());
  await withMockedFetch(() => Response.json({ data: [rawModel({ id: 'k3', display_name: 'K3' }), rawModel({ id: 'k3-highspeed', display_name: 'K3 Highspeed' })] }), async () => {
    const models = await provider.instance.getProvidedModels(testFetcher);
    expect(models.map(model => [model.id, model.providerData])).toEqual([['kimi-k3', { standardModelId: 'k3', fastModelId: 'k3-highspeed' }]]);
  });
});

test('a fast-only family acquires a newly cataloged standard lane without changing its public id', async () => {
  const provider = createKimiCodeProvider(record());
  await withMockedFetch(() => Response.json({ data: [...speedCatalog(), rawModel({ id: 'k2.7-code', display_name: 'K2.7 Code' })] }), async () => {
    const models = await provider.instance.getProvidedModels(testFetcher);
    const family = models.filter(model => model.id === 'kimi-k2.7-code');
    expect(family).toHaveLength(1);
    expect(family[0]).toMatchObject({ upstreamModelId: 'k2.7-code', providerData: { standardModelId: 'k2.7-code', fastModelId: 'kimi-for-coding-highspeed' }, limits: { max_context_window_tokens: 262_144 } });
    expect(models.find(model => model.id === 'kimi-k2.8-preview')?.providerData).toEqual({ standardModelId: 'kimi-for-coding' });
  });
});

test('unrecognized identity cannot merge conflicting raw rows into one public family', async () => {
  const provider = createKimiCodeProvider(record());
  await withMockedFetch(() => Response.json({ data: [rawModel({ id: 'unknown', display_name: 'Unknown' }), rawModel({ id: 'unknown-highspeed', display_name: 'Unknown Highspeed' })] }), async () => {
    await expect(provider.instance.getProvidedModels(testFetcher)).rejects.toMatchObject({ name: 'ProviderModelsUnavailableError', cause: new TypeError('Kimi Code catalog contains conflicting model families: kimi-unknown') });
  });
});

test('a catalog containing only an unrecognized Preview Highspeed alias fails after logging the skipped row', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const provider = createKimiCodeProvider(record());
  await withMockedFetch(() => Response.json({ data: [rawModel({ id: 'kimi-for-coding-highspeed', display_name: 'K4.2 Preview Highspeed' })] }), async () => {
    await expect(provider.instance.getProvidedModels(testFetcher)).rejects.toMatchObject({ name: 'ProviderModelsUnavailableError', cause: new TypeError('Kimi Code catalog contains no publishable models') });
    expect(warn).toHaveBeenCalledWith('Skipping Kimi Code model with an unrecognized display name:', 'kimi-for-coding-highspeed', 'K4.2 Preview Highspeed');
  });
});
