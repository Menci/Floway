import { test } from 'vitest';

import { tokenCountsFromUsage } from '../../../src/repo/usage-metrics.ts';
import { buildCustomUpstreamRecord, copilotModels, MOCKED_FETCH_EGRESS, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { flushBackground } from '../../test-utils/background-tracker.ts';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { assert, jsonResponse, withMockedFetch, assertEquals, assertExists } from '@floway-dev/test-utils';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/wEAAAAASUVORK5CYII=';

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>(res => {
    resolve = res;
  });
  return { promise, resolve };
};

const IMAGE_USAGE = {
  total_tokens: 60,
  input_tokens: 10,
  output_tokens: 50,
  input_tokens_details: { text_tokens: 6, image_tokens: 4 },
};

const registerImagesUpstream = async (
  repo: Awaited<ReturnType<typeof setupAppTest>>['repo'],
  endpoints: ModelEndpoints = { imagesGenerations: {}, imagesEdits: {} },
): Promise<void> => {
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_images',
    name: 'Custom Image Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://images.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-images',
      endpoints: {},
      modelsFetch: { enabled: false },
      models: [{ upstreamModelId: 'gpt-image-2', endpoints }],
    },
  }));
};

const imageSseResponse = (body: BodyInit | null): Response =>
  new Response(body, { headers: { 'content-type': 'text/event-stream', 'x-provider-trace': 'image-trace' } });

const imageSseFrame = (event: Record<string, unknown>): string =>
  `event: ${event.type as string}\ndata: ${JSON.stringify(event)}\n\n`;

const requestGenerationStream = (apiKey: string): Promise<Response> =>
  requestApp('/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a shiba in space', stream: true }),
  });

const assertFailedStreamSettlement = async (
  repo: Awaited<ReturnType<typeof setupAppTest>>['repo'],
): Promise<void> => {
  await flushBackground();
  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(usage[0]?.requests, 1);
  assertEquals(usage[0]?.metrics, []);
  const performance = await repo.performance.listAll();
  assertEquals(performance.length, 1);
  assertEquals(performance[0]?.requests, 1);
  assertEquals(performance[0]?.errorsNoOutput, 1);
};

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
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'copilot-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'no-such-model', prompt: 'hi' }),
      });
      assertEquals(response.status, 404);
    },
  );
});

test('/v1/images/edits rejects malformed JSON with 400', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/v1/images/edits', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: 'not json',
  });
  assertEquals(response.status, 400);
});

test('/v1/images/edits rejects JSON without a model with 400', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/v1/images/edits', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ prompt: 'hi', images: [{ file_id: 'file-image' }] }),
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
  clearInProcessCopilotTokenCache();

  // Chat-only custom upstream. Its /models response advertises gpt-4o
  // (which the id heuristic leaves as the chat fallback), so the resolver
  // returns `sawModel=true` with zero candidates after the kind filter
  // — distinguishing wrong-kind from unknown-id at the resolver layer.
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_chat_only',
    name: 'Chat Only Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://chat.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-chat',
      endpoints: { chatCompletions: {} },
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
  clearInProcessCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_images',
    name: 'Custom Image Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://images.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-images',
      endpoints: {},
    },
  }));

  let forwarded: Record<string, unknown> | undefined;
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'copilot-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      if (url.hostname === 'images.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ data: [{ id: 'gpt-image-2' }] });
      }
      if (url.hostname === 'images.example.com' && url.pathname === '/v1/images/generations') {
        forwarded = await request.json() as Record<string, unknown>;
        return jsonResponse({ data: [{ b64_json: 'aGVsbG8=' }], usage: IMAGE_USAGE });
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
      await flushBackground();
    },
  );
  assertExists(forwarded);
  assertEquals(forwarded.model, 'gpt-image-2');
  assertEquals(forwarded.prompt, 'a shiba in space');
  const usageRows = await repo.usage.listAll();
  assertEquals(usageRows.length, 1);
  assertEquals(tokenCountsFromUsage(usageRows[0]!), { input: 6, input_image: 4, output_image: 50 });
});

test('/v1/images/edits forwards a multipart request through an Azure model and records usage', async () => {
  const { apiKey, repo } = await setupAppTest();
  clearInProcessCopilotTokenCache();
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
        endpoints: { imagesEdits: {} },
      }],
    },
    state: null,
  });

  let observedUrl: string | undefined;
  let observedForm: FormData | undefined;
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'copilot-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      if (url.hostname === 'example.openai.azure.com') {
        observedUrl = request.url;
        observedForm = await request.formData();
        return jsonResponse({
          data: [{ b64_json: 'aGk=' }],
          usage: {
            total_tokens: 18,
            input_tokens: 7,
            output_tokens: 11,
            input_tokens_details: { text_tokens: 5, image_tokens: 2 },
          },
        });
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
      await flushBackground();
    },
  );
  assertEquals(observedUrl?.endsWith('?api-version=preview'), true);
  assertEquals(observedForm?.get('model'), 'gpt-image-2');
  const usageRows = await repo.usage.listAll();
  assertEquals(usageRows.length, 1);
  assertEquals(tokenCountsFromUsage(usageRows[0]!), { input: 5, input_image: 2, output_image: 11 });
});

test('/v1/images/edits forwards JSON image references through a custom provider', async () => {
  const { apiKey, repo } = await setupAppTest();
  clearInProcessCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_image_edits_json',
    name: 'Custom Image Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://images.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-images',
      endpoints: {},
    },
  }));

  let forwarded: Record<string, unknown> | undefined;
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'copilot-chat', supported_endpoints: ['/chat/completions'] }]));
      }
      if (url.hostname === 'images.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ data: [{ id: 'gpt-image-2' }] });
      }
      if (url.hostname === 'images.example.com' && url.pathname === '/v1/images/edits') {
        forwarded = await request.json() as Record<string, unknown>;
        return jsonResponse({ data: [{ b64_json: 'ZWRpdA==' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/images/edits', {
        method: 'POST',
        headers: { 'content-type': 'Application/Vnd.OpenAI+JSON; charset=utf-8', 'x-api-key': apiKey.key },
        body: JSON.stringify({
          model: 'gpt-image-2',
          prompt: 'replace the background',
          images: [
            { image_url: `data:image/png;base64,${PNG_B64}` },
            { file_id: 'file-source' },
          ],
          mask: { file_id: 'file-mask' },
          quality: 'high',
        }),
      });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), { data: [{ b64_json: 'ZWRpdA==' }] });
    },
  );

  assertEquals(forwarded, {
    model: 'gpt-image-2',
    prompt: 'replace the background',
    images: [
      { image_url: `data:image/png;base64,${PNG_B64}` },
      { file_id: 'file-source' },
    ],
    mask: { file_id: 'file-mask' },
    quality: 'high',
  });
});
