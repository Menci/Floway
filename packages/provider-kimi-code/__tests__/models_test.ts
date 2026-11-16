import { expect, test } from 'vitest';

import { config, rawModel, record } from './fixtures.ts';
import { createKimiCodeProvider } from '../src/provider.ts';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';
import { testFetcher, withMockedFetch } from '@floway-dev/test-utils';

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
      id: 'arbitrary-model', display_name: 'A catalog model', upstreamModelId: 'arbitrary-model', kind: 'chat',
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
