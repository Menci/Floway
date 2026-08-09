import { test } from 'vitest';

import type { InMemoryRepo } from '../../repo/memory.ts';
import { copilotModels, MOCKED_FETCH_EGRESS, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { CODEX_USER_AGENT } from '@floway-dev/provider-codex';
import { assertEquals, assertExists, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/wEAAAAASUVORK5CYII=';

const saveAzureImages = async (repo: InMemoryRepo): Promise<void> => {
  await repo.upstreams.save({
    id: 'az-image',
    kind: 'azure',
    name: 'azure-images',
    enabled: true,
    sortOrder: 1,
    createdAt: '2026-05-25T00:00:00Z',
    updatedAt: '2026-05-25T00:00:00Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: MOCKED_FETCH_EGRESS,
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    config: {
      endpoint: 'https://example.openai.azure.com/openai/v1',
      apiKey: 'azkey',
      models: [{
        upstreamModelId: 'gpt-image-2',
        endpoints: { imagesGenerations: {}, imagesEdits: {} },
      }],
    },
    state: null,
  });
};

const saveCodexImages = async (repo: InMemoryRepo): Promise<void> => {
  await repo.upstreams.save({
    id: 'codex-image',
    kind: 'codex',
    name: 'ChatGPT Team',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-08-09T00:00:00Z',
    updatedAt: '2026-08-09T00:00:00Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: MOCKED_FETCH_EGRESS,
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    config: {
      accounts: [{ email: 'team@example.test', chatgptAccountId: 'account', chatgptUserId: 'user', planType: 'team' }],
    },
    state: {
      accounts: [{
        chatgptAccountId: 'account',
        refresh_token: 'refresh',
        state: 'active',
        state_updated_at: '2026-08-09T00:00:00Z',
        openaiDeviceId: '11111111-2222-4333-8444-555555555555',
        accessToken: { token: 'access', expiresAt: 4102444800000, refreshedAt: '2026-08-09T00:00:00Z' },
        quotaSnapshot: null,
      }],
    },
  });
};

const controlPlaneFetch = (request: Request): Response | undefined => {
  const url = new URL(request.url);
  if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
  if (url.pathname === '/copilot_internal/v2/token') {
    return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
  }
  if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
    return jsonResponse(copilotModels([{ id: 'copilot-chat', supported_endpoints: ['/chat/completions'] }]));
  }
  return undefined;
};

test('Codex provider-relative image generation reuses the public image-generation handler', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveAzureImages(repo);
  let observedUrl: string | undefined;
  let observedBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const control = controlPlaneFetch(request);
      if (control) return control;
      const url = new URL(request.url);
      if (url.hostname === 'example.openai.azure.com') {
        observedUrl = request.url;
        observedBody = await request.json() as Record<string, unknown>;
        return jsonResponse({ data: [{ b64_json: 'aGk=' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/azure-api.codex/images/generations', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a fox in space', quality: 'high' }),
      });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), { data: [{ b64_json: 'aGk=' }] });
    },
  );

  assertEquals(observedUrl?.endsWith('/images/generations?api-version=preview'), true);
  assertExists(observedBody);
  assertEquals(observedBody.prompt, 'a fox in space');
  assertEquals(observedBody.quality, 'high');
});

test('ChatGPT Codex accounts expose and serve the implicit gpt-image-2 model', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveCodexImages(repo);
  let observedBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const control = controlPlaneFetch(request);
      if (control) return control;
      const url = new URL(request.url);
      if (url.pathname === '/backend-api/codex/models') {
        return jsonResponse({ models: [{ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol', context_window: 1000000 }] });
      }
      if (url.pathname === '/backend-api/codex/images/generations') {
        observedBody = await request.json() as Record<string, unknown>;
        return jsonResponse({ created: 1, data: [{ b64_json: 'aGk=' }], background: 'opaque', quality: 'low', size: '1254x1254' });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const publicModels = await requestApp('/v1/models', {
        headers: { authorization: `Bearer ${apiKey.key}` },
      });
      assertEquals(publicModels.status, 200);
      const publicCatalog = await publicModels.json() as { data: { id: string }[] };
      assertEquals(publicCatalog.data.some(model => model.id === 'gpt-image-2'), true);

      const codexModels = await requestApp('/azure-api.codex/models?client_version=0.147.0', {
        headers: { authorization: `Bearer ${apiKey.key}`, 'user-agent': CODEX_USER_AGENT },
      });
      assertEquals(codexModels.status, 200);
      const codexCatalog = await codexModels.json() as { models: { slug: string }[] };
      assertEquals(codexCatalog.models.some(model => model.slug === 'gpt-image-2'), false);

      const response = await requestApp('/azure-api.codex/images/generations', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-image-2', prompt: 'an orange circle', quality: 'low' }),
      });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), { created: 1, data: [{ b64_json: 'aGk=' }], background: 'opaque', quality: 'low', size: '1254x1254' });
    },
  );

  assertEquals(observedBody, { model: 'gpt-image-2', prompt: 'an orange circle', quality: 'low' });
});

test('Codex provider-relative image edits reuse the public JSON handler', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveAzureImages(repo);
  let observedUrl: string | undefined;
  let observedBody: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const control = controlPlaneFetch(request);
      if (control) return control;
      const url = new URL(request.url);
      if (url.hostname === 'example.openai.azure.com') {
        observedUrl = request.url;
        observedBody = await request.json() as Record<string, unknown>;
        return jsonResponse({ data: [{ b64_json: 'ZWRpdA==' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/azure-api.codex/images/edits', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-image-2',
          prompt: 'add a red hat',
          quality: 'high',
          images: [
            { image_url: 'https://assets.example/image.png' },
          ],
        }),
      });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), { data: [{ b64_json: 'ZWRpdA==' }] });
    },
  );

  assertEquals(observedUrl?.endsWith('/images/edits?api-version=preview'), true);
  assertExists(observedBody);
  assertEquals(observedBody, {
    model: 'gpt-image-2',
    prompt: 'add a red hat',
    quality: 'high',
    images: [{ image_url: 'https://assets.example/image.png' }],
  });
});

test('Codex inline data URL edits egress as multipart uploads', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveAzureImages(repo);
  let observedForm: FormData | undefined;

  await withMockedFetch(
    async request => {
      const control = controlPlaneFetch(request);
      if (control) return control;
      if (new URL(request.url).hostname === 'example.openai.azure.com') {
        observedForm = await request.formData();
        return jsonResponse({ data: [{ b64_json: 'ZWRpdA==' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/azure-api.codex/images/edits', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-image-2',
          prompt: 'add a red hat',
          images: [{ image_url: `data:image/png;base64,${PNG_B64}` }],
        }),
      });
      assertEquals(response.status, 200);
    },
  );

  assertExists(observedForm);
  const image = observedForm.get('image');
  assertEquals(image instanceof File, true);
  assertEquals((image as File).type, 'image/png');
});
