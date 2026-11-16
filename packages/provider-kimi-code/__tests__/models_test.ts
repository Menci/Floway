import { afterEach, expect, test, vi } from 'vitest';

import { config, rawModel, record } from './fixtures.ts';
import { createKimiCodeProvider } from '../src/provider.ts';
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
      id: 'kimi-arbitrary-model', display_name: 'A catalog model', upstreamModelId: 'arbitrary-model', kind: 'chat',
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

test('all six catalog rows expose presentation ids while preserving raw upstream identities', async () => {
  const rows = [
    ['kimi-for-coding', 'K2.8 Preview', 'kimi-k2.8-preview'],
    ['kimi-for-coding-highspeed', 'K2.7 Code Highspeed', 'kimi-kimi-for-coding-highspeed'],
    ['k3', 'K3', 'kimi-k3'],
    ['k3-256k', 'K3-256k', 'kimi-k3-256k'],
    ['k3.1-pro', 'K3.1 Pro', 'kimi-k3.1-pro'],
    ['k3.1-pro-highspeed', 'K3.1 Pro Highspeed 2x Usage Cost', 'kimi-k3.1-pro-highspeed'],
  ];
  const provider = createKimiCodeProvider(record());
  await withMockedFetch(() => Response.json({ data: rows.map(([id, display_name]) => rawModel({ id, display_name })) }), async () => {
    const models = await provider.instance.getProvidedModels(testFetcher);
    expect(models.map(model => [model.upstreamModelId, model.display_name, model.id])).toEqual(rows);
    expect(models.map(model => model.providerData)).toEqual(rows.map(([id]) => id));
    expect(models.some(model => model.id === 'kimi-for-coding')).toBe(false);
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
