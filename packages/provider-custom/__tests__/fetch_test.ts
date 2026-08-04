import { test } from 'vitest';

import { assertCustomUpstreamRecord } from '../src/config.ts';
import {
  customFetchAlphaSearch,
  customFetchAudioTranscriptions,
  customFetchChatCompletions,
  customFetchEmbeddings,
  customFetchMessages,
  customFetchMessagesCountTokens,
  customFetchModels,
  customFetchResponses,
  customFetchResponsesCompact,
} from '../src/fetch.ts';
import { createCustomProvider } from '../src/provider.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { directFetcher, identityWrapUpstreamCall } from '@floway-dev/provider';
import { assertEquals, assertExists, jsonResponse, noopUpstreamCallOptions, withMockedFetch } from '@floway-dev/test-utils';

const baseRecord: UpstreamRecord = {
  id: 'up_test',
  kind: 'custom',
  name: 'Test Custom',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-04-29T00:00:00.000Z',
  updatedAt: '2026-04-29T00:00:00.000Z',
  config: {
    baseUrl: 'https://custom.example.com',
    authStyle: 'bearer',
    apiKey: 'sk-test',
    endpoints: { chatCompletions: {} },
  },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  modelsCache: null,
  hue: 210,
};

test('typed transports use default /v1/* paths', async () => {
  const { config } = assertCustomUpstreamRecord(baseRecord);

  const seen: string[] = [];
  await withMockedFetch(
    request => {
      seen.push(request.url);
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetchChatCompletions(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchResponses(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchResponsesCompact(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchMessages(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchMessagesCountTokens(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchAlphaSearch(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchEmbeddings(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchAudioTranscriptions(config, { method: 'POST', body: new FormData() }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchModels(config, { method: 'GET' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(seen, [
    'https://custom.example.com/v1/chat/completions',
    'https://custom.example.com/v1/responses',
    'https://custom.example.com/v1/responses/compact',
    'https://custom.example.com/v1/messages',
    'https://custom.example.com/v1/messages/count_tokens',
    'https://custom.example.com/v1/alpha/search',
    'https://custom.example.com/v1/embeddings',
    'https://custom.example.com/v1/audio/transcriptions',
    'https://custom.example.com/v1/models',
  ]);
});

test('admin pathOverrides replace defaults and propagate to derived sub-paths', async () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      pathOverrides: {
        '/messages': '/api/v1/messages',
        '/responses': '/api/v1/responses',
        '/alpha/search': '/api/search',
      },
    },
  });
  const seen: string[] = [];
  await withMockedFetch(
    request => {
      seen.push(request.url);
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetchMessages(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      // count_tokens / compact follow their parent override.
      await customFetchMessagesCountTokens(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchResponsesCompact(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      await customFetchAlphaSearch(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
      // Endpoints without an override fall back to the OpenAI default.
      await customFetchChatCompletions(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(seen, [
    'https://custom.example.com/api/v1/messages',
    'https://custom.example.com/api/v1/messages/count_tokens',
    'https://custom.example.com/api/v1/responses/compact',
    'https://custom.example.com/api/search',
    'https://custom.example.com/v1/chat/completions',
  ]);
});

test('customFetchModels resolves the path from modelsFetch.endpoint', async () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      modelsFetch: { enabled: true, endpoint: '/models' },
    },
  });
  let seen: string | undefined;
  await withMockedFetch(
    request => {
      seen = request.url;
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetchModels(config, { method: 'GET' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(seen, 'https://custom.example.com/models');
});

test('customFetchModels falls back to the default /v1/models path when modelsFetch.endpoint is absent', async () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      modelsFetch: { enabled: true },
    },
  });
  let seen: string | undefined;
  await withMockedFetch(
    request => {
      seen = request.url;
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetchModels(config, { method: 'GET' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(seen, 'https://custom.example.com/v1/models');
});

test('bearer authStyle sends the configured token via Authorization', async () => {
  const { config } = assertCustomUpstreamRecord(baseRecord);
  let authHeader: string | null = null;
  let xApiKey: string | null = null;
  await withMockedFetch(
    request => {
      authHeader = request.headers.get('authorization');
      xApiKey = request.headers.get('x-api-key');
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetchModels(config, { method: 'GET' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(authHeader, 'Bearer sk-test');
  assertEquals(xApiKey, null);
});

test('authStyle "anthropic" sends x-api-key + anthropic-version', async () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      authStyle: 'anthropic',
    },
  });
  let authHeader: string | null = null;
  let xApiKey: string | null = null;
  let anthropicVersion: string | null = null;
  await withMockedFetch(
    request => {
      authHeader = request.headers.get('authorization');
      xApiKey = request.headers.get('x-api-key');
      anthropicVersion = request.headers.get('anthropic-version');
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetchMessages(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(authHeader, null);
  assertEquals(xApiKey, 'sk-test');
  assertEquals(anthropicVersion, '2023-06-01');
});

test('authStyle "anthropic" preserves a caller-supplied anthropic-version', async () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      ...(baseRecord.config as Record<string, unknown>),
      authStyle: 'anthropic',
    },
  });
  let anthropicVersion: string | null = null;
  await withMockedFetch(
    request => {
      anthropicVersion = request.headers.get('anthropic-version');
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetchMessages(
        config,
        { method: 'POST', body: '{}', headers: { 'anthropic-version': '2024-01-01' } },
        { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall },
      );
    },
  );

  assertEquals(anthropicVersion, '2024-01-01');
});

test('authStyle "none" sends neither Authorization nor x-api-key', async () => {
  const { config } = assertCustomUpstreamRecord({
    ...baseRecord,
    config: {
      baseUrl: 'https://internal.example.com',
      authStyle: 'none',
      endpoints: { chatCompletions: {} },
    },
  });
  let authHeader: string | null = null;
  let xApiKey: string | null = null;
  let anthropicVersion: string | null = null;
  await withMockedFetch(
    request => {
      authHeader = request.headers.get('authorization');
      xApiKey = request.headers.get('x-api-key');
      anthropicVersion = request.headers.get('anthropic-version');
      return new Response('{}', { status: 200 });
    },
    async () => {
      await customFetchChatCompletions(config, { method: 'POST', body: '{}' }, { fetcher: directFetcher, wrapUpstreamCall: identityWrapUpstreamCall });
    },
  );

  assertEquals(authHeader, null);
  assertEquals(xApiKey, null);
  assertEquals(anthropicVersion, null);
});

test('Custom provider callImagesEdits forwards multipart body with model field appended', async () => {
  const record: UpstreamRecord = {
    ...baseRecord,
    config: {
      baseUrl: 'https://custom.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-custom',
      endpoints: { chatCompletions: {} },
    },
  };
  let forwarded: { url: string; form: FormData } | undefined;
  await withMockedFetch(
    async request => {
      const path = new URL(request.url).pathname;
      if (path === '/v1/models') return jsonResponse({ data: [{ id: 'gpt-image-2' }] });
      if (path === '/v1/images/edits') {
        forwarded = { url: request.url, form: await request.formData() };
        return jsonResponse({ data: [{ b64_json: 'abc' }], usage: { input_tokens: 5, output_tokens: 20 } });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const provider = createCustomProvider(record);
      const [model] = await provider.instance.getProvidedModels(directFetcher);
      const result = await provider.instance.callImagesEdits(model, {
        parameters: { prompt: 'add a kite' },
        images: [{
          type: 'upload',
          file: new File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' }),
        }],
      }, undefined, noopUpstreamCallOptions());
      assertEquals(result.modelKey, 'gpt-image-2');
      assertEquals(result.response.status, 200);
    },
  );
  assertExists(forwarded);
  assertEquals(forwarded.form.get('model'), 'gpt-image-2');
  assertEquals(forwarded.form.get('prompt'), 'add a kite');
  assertEquals(forwarded.form.get('image') instanceof File, true);
});

test('Custom provider callAudioTranscriptions preserves multipart entries and honors the path override', async () => {
  const record: UpstreamRecord = {
    ...baseRecord,
    config: {
      baseUrl: 'https://custom.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-custom',
      endpoints: {},
      pathOverrides: { '/audio/transcriptions': '/speech/to-text' },
      modelsFetch: { enabled: false },
      models: [{ upstreamModelId: 'whisper-upstream', kind: 'transcription', endpoints: { audioTranscriptions: {} } }],
    },
  };
  let forwarded: { url: string; form: FormData } | undefined;
  await withMockedFetch(
    async request => {
      forwarded = { url: request.url, form: await request.formData() };
      return jsonResponse({ text: 'hello' });
    },
    async () => {
      const provider = createCustomProvider(record);
      const [model] = await provider.instance.getProvidedModels(directFetcher);
      const result = await provider.instance.callAudioTranscriptions(model, {
        entries: [
          { name: 'file', value: new File([new Uint8Array([7, 8])], 'voice.ogg', { type: 'audio/ogg' }) },
          { name: 'model', value: 'public-model' },
          { name: 'language', value: 'en' },
        ],
      }, undefined, noopUpstreamCallOptions());
      assertEquals(result.modelKey, 'whisper-upstream');
    },
  );
  assertExists(forwarded);
  assertEquals(forwarded.url, 'https://custom.example.com/speech/to-text');
  assertEquals(forwarded.form.get('model'), 'whisper-upstream');
  assertEquals(forwarded.form.get('language'), 'en');
  const file = forwarded.form.get('file');
  assertEquals(file instanceof File, true);
  assertEquals((file as File).name, 'voice.ogg');
  assertEquals((file as File).type, 'audio/ogg');
});
