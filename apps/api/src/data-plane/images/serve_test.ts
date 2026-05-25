import { test } from 'vitest';

import { clearCopilotTokenCache } from '../../shared/copilot.ts';
import { assertEquals, assertExists } from '../../test-assert.ts';
import { buildCustomUpstreamRecord, copilotModels, flushAsyncWork, jsonResponse, requestApp, setupAppTest, withMockedFetch } from '../../test-helpers.ts';
import { clearModelsStore } from '../providers/models-store.ts';

test('/v1/images/generations rejects malformed JSON body with 400', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: 'not json',
  });
  assertEquals(response.status, 400);
});

test('/v1/images/generations rejects body without model with 400', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ prompt: 'hi' }),
  });
  assertEquals(response.status, 400);
});

test('/v1/images/generations 404s when no upstream provides the model', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600 });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'copilot-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'no-such-model', prompt: 'hi' }),
      });
      assertEquals(response.status, 404);
    },
  );
});

test('/v1/images/edits rejects non-multipart body with 400', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/v1/images/edits', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: '{}',
  });
  assertEquals(response.status, 400);
});

test('/v1/images/edits rejects multipart body without model field with 400', async () => {
  const { apiKey } = await setupAppTest();
  const form = new FormData();
  form.append('prompt', 'hi');
  const response = await requestApp('/v1/images/edits', {
    method: 'POST',
    headers: { 'x-api-key': apiKey.key },
    body: form,
  });
  assertEquals(response.status, 400);
});

test('/v1/images/generations rejects model on custom upstream without /images/generations capability', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearModelsStore();
  await clearCopilotTokenCache();

  // Chat-only custom upstream. Its /models response advertises gpt-4o
  // (which inferKindFromModelId resolves to 'chat'), so the model exists
  // in the registry but no binding accepts an images_generations request.
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_chat_only',
    name: 'Chat Only Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://chat.example.com',
      bearerToken: 'sk-chat',
      supportedEndpoints: ['/chat/completions'],
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'chat.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'gpt-4o' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'gpt-4o', prompt: 'hi' }),
      });
      assertEquals(response.status, 400);
      const body = await response.json() as { error: { message: string } };
      assertEquals(body.error.message, 'Model gpt-4o does not support the /images/generations endpoint.');
    },
  );
});

test('/v1/images/generations forwards a JSON request through a custom upstream and records usage', async () => {
  const { apiKey, repo } = await setupAppTest();
  // setupAppTest seeds only a Copilot upstream by default; register a custom
  // upstream whose /models response declares the requested image model.
  clearModelsStore();
  await clearCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_images',
    name: 'Custom Image Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://images.example.com',
      bearerToken: 'sk-images',
      supportedEndpoints: [],
    },
  }));

  let forwarded: Record<string, unknown> | undefined;
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600 });
      }
      if (url.hostname === 'api.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'copilot-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      if (url.hostname === 'images.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ data: [{ id: 'gpt-image-2' }] });
      }
      if (url.hostname === 'images.example.com' && url.pathname === '/v1/images/generations') {
        forwarded = await request.json() as Record<string, unknown>;
        return jsonResponse({ data: [{ b64_json: 'aGVsbG8=' }], usage: { input_tokens: 10, output_tokens: 50 } });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a shiba in space' }),
      });
      assertEquals(response.status, 200);
      const body = await response.json() as { data: { b64_json: string }[] };
      assertEquals(body.data[0].b64_json, 'aGVsbG8=');
      await flushAsyncWork();
    },
  );
  assertExists(forwarded);
  assertEquals(forwarded.model, 'gpt-image-2');
  assertEquals(forwarded.prompt, 'a shiba in space');
  const usageRows = await repo.usage.listAll();
  assertEquals(usageRows.some(row => row.model === 'gpt-image-2' && row.inputTokens === 10 && row.outputTokens === 50), true);
});

test('/v1/images/edits forwards a multipart request through an Azure deployment and records usage', async () => {
  // setupAppTest seeds a Copilot upstream by default; we also register an
  // Azure upstream that exposes gpt-image-2 via /v1/images/edits.
  const { apiKey, repo } = await setupAppTest();
  clearModelsStore();
  await clearCopilotTokenCache();
  await repo.upstreams.save({
    id: 'az-image',
    provider: 'azure',
    name: 'azure-images',
    enabled: true,
    sortOrder: 1,
    createdAt: '2026-05-25T00:00:00Z',
    updatedAt: '2026-05-25T00:00:00Z',
    flagOverrides: {},
    config: {
      endpoint: 'https://example.openai.azure.com/openai/v1',
      apiKey: 'azkey',
      deployments: [{
        deployment: 'gpt-image-2',
        supportedEndpoints: ['/v1/images/edits'],
      }],
    },
  });

  let observedUrl: string | undefined;
  let observedForm: FormData | undefined;
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600 });
      }
      if (url.hostname === 'api.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'copilot-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      if (url.hostname === 'example.openai.azure.com') {
        observedUrl = request.url;
        observedForm = await request.formData();
        return jsonResponse({ data: [{ b64_json: 'aGk=' }], usage: { input_tokens: 7, output_tokens: 11 } });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const form = new FormData();
      form.append('model', 'gpt-image-2');
      form.append('prompt', 'replace sky with aurora');
      form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'photo.png');
      const response = await requestApp('/v1/images/edits', {
        method: 'POST',
        headers: { 'x-api-key': apiKey.key },
        body: form,
      });
      assertEquals(response.status, 200);
      const body = await response.json() as { data: { b64_json: string }[] };
      assertEquals(body.data[0].b64_json, 'aGk=');
      await flushAsyncWork();
    },
  );
  assertEquals(observedUrl?.endsWith('?api-version=preview'), true);
  assertEquals(observedForm?.get('model'), 'gpt-image-2');
  const usageRows = await repo.usage.listAll();
  assertEquals(usageRows.some(row => row.model === 'gpt-image-2' && row.inputTokens === 7 && row.outputTokens === 11), true);
});
