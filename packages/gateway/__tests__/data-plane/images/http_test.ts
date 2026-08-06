import { test } from 'vitest';

import {
  imageEditUploadSizeError,
  MAX_IMAGE_EDIT_FILE_BYTES,
  MAX_IMAGE_EDIT_MASK_BYTES,
  MAX_IMAGE_EDIT_MULTIPART_BODY_BYTES,
} from '../../../src/data-plane/images/http.ts';
import { initDumpBroker, initDumpStore } from '../../../src/dump/registry.ts';
import { tokenCountsFromUsage } from '../../../src/repo/usage-metrics.ts';
import { installDumpStubs } from '../../dump/test-fixtures.ts';
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
  await response.json();
});

test('/v1/images/generations rejects body without model with 400', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ prompt: 'hi' }),
  });
  assertEquals(response.status, 400);
  await response.json();
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
      await response.json();
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
  await response.json();
});

test('/v1/images/edits rejects JSON without a model with 400', async () => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/v1/images/edits', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ prompt: 'hi', images: [{ file_id: 'file-image' }] }),
  });
  assertEquals(response.status, 400);
  await response.json();
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
  await response.json();
});

test.each([
  ['duplicate text', 'alternate-model'],
  ['mixed file', new Blob(['alternate-model'], { type: 'text/plain' })],
] as const)('/v1/images/edits rejects %s multipart model values with 400', async (_name, duplicateModel) => {
  const { apiKey } = await setupAppTest();
  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('model', duplicateModel);
  form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'source.png');
  const response = await requestApp('/v1/images/edits', {
    method: 'POST',
    headers: { 'x-api-key': apiKey.key },
    body: form,
  });
  assertEquals(response.status, 400);
  assertEquals(await response.json(), {
    error: {
      message: 'Image edits request body must include a model field.',
      type: 'api_error',
    },
  });
});

test('/v1/images/edits requires at least one image for JSON and multipart requests', async () => {
  const { apiKey } = await setupAppTest();
  const json = await requestApp('/v1/images/edits', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify({ model: 'gpt-image-2', prompt: 'edit', images: [] }),
  });
  assertEquals(json.status, 400);
  assertEquals(await json.json(), { error: { message: 'Image edits request body must include at least one image.', type: 'api_error' } });

  const form = new FormData();
  form.append('model', 'gpt-image-2');
  form.append('prompt', 'edit');
  const multipart = await requestApp('/v1/images/edits', {
    method: 'POST', headers: { 'x-api-key': apiKey.key }, body: form,
  });
  assertEquals(multipart.status, 400);
  assertEquals(await multipart.json(), { error: { message: 'Image edits request body must include at least one image file.', type: 'api_error' } });
});

test('/v1/images/edits accepts sixteen JSON images and rejects a seventeenth pre-dispatch', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerImagesUpstream(repo);
  const sixteen = Array.from({ length: 16 }, (_, index) => ({ file_id: `file-${index}` }));
  let forwarded: Record<string, unknown> | undefined;
  await withMockedFetch(
    async request => {
      forwarded = await request.json() as Record<string, unknown>;
      return jsonResponse({ data: [{ b64_json: 'ZWRpdA==' }] });
    },
    async () => {
      const accepted = await requestApp('/v1/images/edits', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'gpt-image-2', prompt: 'edit', images: sixteen }),
      });
      assertEquals(accepted.status, 200);
      await accepted.json();
    },
  );
  assertEquals((forwarded?.images as unknown[]).length, 16);

  let upstreamCalls = 0;
  await withMockedFetch(
    () => {
      upstreamCalls += 1;
      return jsonResponse({ data: [] });
    },
    async () => {
      const rejected = await requestApp('/v1/images/edits', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'gpt-image-2', prompt: 'edit', images: [...sixteen, { file_id: 'file-16' }] }),
      });
      assertEquals(rejected.status, 400);
      await rejected.json();
    },
  );
  assertEquals(upstreamCalls, 0);
});

test('image edit upload byte limits are exact without allocating production-sized files', () => {
  assertEquals(MAX_IMAGE_EDIT_FILE_BYTES, 50 * 1024 * 1024);
  assertEquals(MAX_IMAGE_EDIT_MASK_BYTES, 4 * 1024 * 1024);
  assertEquals(MAX_IMAGE_EDIT_MULTIPART_BODY_BYTES, 56 * 1024 * 1024);
  assertEquals(imageEditUploadSizeError({ size: 3 }, 'image', 4), null);
  assertEquals(imageEditUploadSizeError({ size: 4 }, 'image', 4), 'Image edits image file must be smaller than 4 bytes.');
  assertEquals(imageEditUploadSizeError({ size: 4 }, 'mask', 4), 'Image edits mask file must be smaller than 4 bytes.');
});

test('/v1/images/edits applies its multipart wire budget before reading an oversized upload', async () => {
  const response = await requestApp('/v1/images/edits', {
    method: 'POST',
    headers: {
      'content-type': 'multipart/form-data; boundary=unused',
      'content-length': String(MAX_IMAGE_EDIT_MULTIPART_BODY_BYTES + 1),
    },
    body: new ReadableStream<Uint8Array>(),
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });

  assertEquals(response.status, 413);
  assertEquals((await response.json()).error.max_bytes, MAX_IMAGE_EDIT_MULTIPART_BODY_BYTES);
});

test('/v1/images/edits rejects seventeen multipart images and duplicate masks', async () => {
  const { apiKey } = await setupAppTest();
  for (const configure of [
    (form: FormData) => {
      for (let index = 0; index < 17; index++) form.append('image', new Blob([Uint8Array.of(index)]), `image-${index}.png`);
    },
    (form: FormData) => {
      form.append('image', new Blob([Uint8Array.of(1)]), 'image.png');
      form.append('mask', new Blob([Uint8Array.of(2)]), 'mask-a.png');
      form.append('mask', new Blob([Uint8Array.of(3)]), 'mask-b.png');
    },
  ]) {
    const form = new FormData();
    form.append('model', 'gpt-image-2');
    configure(form);
    const response = await requestApp('/v1/images/edits', {
      method: 'POST', headers: { 'x-api-key': apiKey.key }, body: form,
    });
    assertEquals(response.status, 400);
    await response.json();
  }
});

test('/v1/images/generations rejects a model of the wrong kind', async () => {
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

test.each([
  {
    name: 'generations rejects an edits-only image model',
    endpoints: { imagesEdits: {} },
    path: '/v1/images/generations',
    body: { model: 'gpt-image-2', prompt: 'draw' },
    sourceApi: '/images/generations',
  },
  {
    name: 'edits rejects a generations-only image model',
    endpoints: { imagesGenerations: {} },
    path: '/v1/images/edits',
    body: { model: 'gpt-image-2', prompt: 'edit', images: [{ file_id: 'file-source' }] },
    sourceApi: '/images/edits',
  },
] as const)('/v1/images/$name', async ({ endpoints, path, body, sourceApi }) => {
  const { apiKey, repo } = await setupAppTest();
  await registerImagesUpstream(repo, endpoints);
  const response = await requestApp(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: JSON.stringify(body),
  });
  assertEquals(response.status, 400);
  assertEquals(await response.json(), {
    error: { message: `Model gpt-image-2 does not support the ${sourceApi} endpoint.`, type: 'api_error' },
  });
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

test('/v1/images/generations streams before upstream EOF and settles completed-event usage after EOF', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerImagesUpstream(repo);
  const eofGate = deferred();
  const eofPullStarted = deferred();
  const encoder = new TextEncoder();
  let forwarded: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      forwarded = await request.json() as Record<string, unknown>;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode([
            imageSseFrame({ type: 'image_generation.partial_image', b64_json: 'cGFydGlhbA==', partial_image_index: 0 }),
            imageSseFrame({ type: 'image_generation.completed', b64_json: 'ZmluYWw=', usage: IMAGE_USAGE }),
          ].join('')));
        },
        async pull(controller) {
          eofPullStarted.resolve();
          await eofGate.promise;
          controller.close();
        },
      });
      return imageSseResponse(body);
    },
    async () => {
      const response = await requestGenerationStream(apiKey.key);
      assertEquals(response.status, 200);
      assertEquals(response.headers.get('x-provider-trace'), 'image-trace');
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = '';
      try {
        while (!text.includes('image_generation.completed')) {
          const chunk = await reader.read();
          assertEquals(chunk.done, false, 'stream closed before the completed event');
          text += decoder.decode(chunk.value, { stream: true });
        }
        assertEquals(text.includes('image_generation.partial_image'), true);
        const eofRead = reader.read();
        await eofPullStarted.promise;
        assertEquals(await repo.usage.listAll(), []);

        eofGate.resolve();
        const eofChunk = await eofRead;
        if (!eofChunk.done) text += decoder.decode(eofChunk.value, { stream: true });
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        eofGate.resolve();
        await reader.cancel().catch(() => {});
      }

      assertEquals(text.includes('[DONE]'), false);
      await flushBackground();
    },
  );

  assertExists(forwarded);
  assertEquals(forwarded.stream, true);
  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(tokenCountsFromUsage(usage[0]!), { input: 6, input_image: 4, output_image: 50 });
  const performance = await repo.performance.listAll();
  assertEquals(performance.length, 1);
  assertEquals(performance[0]?.neutral, 1);
  assertEquals(performance[0]?.errorsNoOutput, 0);
});

test('/v1/images/edits streams multipart text true and preserves image and mask files', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerImagesUpstream(repo);
  let upstreamForm: FormData | undefined;
  let upstreamSignal: AbortSignal | undefined;

  await withMockedFetch(
    async request => {
      upstreamSignal = request.signal;
      upstreamForm = await request.formData();
      return imageSseResponse(imageSseFrame({ type: 'image_edit.completed', b64_json: 'ZWRpdGVk', usage: IMAGE_USAGE }));
    },
    async () => {
      const form = new FormData();
      form.append('model', 'gpt-image-2');
      form.append('prompt', 'replace the sky');
      form.append('quality', 'high');
      form.append('stream', 'true');
      form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'source.png');
      form.append('mask', new Blob([new Uint8Array([4, 5])], { type: 'image/webp' }), 'mask.webp');
      const response = await requestApp('/v1/images/edits', {
        method: 'POST', headers: { 'x-api-key': apiKey.key }, body: form,
      });
      assertEquals(response.status, 200);
      assertEquals((await response.text()).includes('image_edit.completed'), true);
      await flushBackground();
    },
  );

  assertExists(upstreamSignal);
  assertEquals(upstreamSignal.aborted, false);
  assertExists(upstreamForm);
  assertEquals(upstreamForm.get('model'), 'gpt-image-2');
  assertEquals(upstreamForm.get('prompt'), 'replace the sky');
  assertEquals(upstreamForm.get('quality'), 'high');
  assertEquals(upstreamForm.get('stream'), 'true');
  const image = upstreamForm.get('image');
  const mask = upstreamForm.get('mask');
  assert(image instanceof File);
  assert(mask instanceof File);
  assertEquals({ name: image.name, type: image.type, bytes: [...new Uint8Array(await image.arrayBuffer())] }, {
    name: 'source.png', type: 'image/png', bytes: [1, 2, 3],
  });
  assertEquals({ name: mask.name, type: mask.type, bytes: [...new Uint8Array(await mask.arrayBuffer())] }, {
    name: 'mask.webp', type: 'image/webp', bytes: [4, 5],
  });
  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(tokenCountsFromUsage(usage[0]!), { input: 6, input_image: 4, output_image: 50 });
});

test.each([
  {
    name: 'EOF without completed',
    body: () => imageSseResponse(imageSseFrame({ type: 'image_generation.partial_image', b64_json: 'cGFydGlhbA==', partial_image_index: 0 })),
    forwarded: 'image_generation.partial_image',
  },
  {
    name: 'malformed event JSON',
    body: () => imageSseResponse('event: image_generation.partial_image\ndata: {not-json}\n\n'),
    forwarded: '{not-json}',
  },
  {
    name: 'a foreign DONE sentinel',
    body: () => imageSseResponse('data: [DONE]\n\n'),
    forwarded: '[DONE]',
  },
  {
    name: 'upstream body read error',
    body: () => {
      const encoder = new TextEncoder();
      let pulled = false;
      return imageSseResponse(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!pulled) {
            pulled = true;
            controller.enqueue(encoder.encode(imageSseFrame({ type: 'image_generation.partial_image', b64_json: 'cGFydGlhbA==' })));
            return;
          }
          controller.error(new Error('upstream image stream failed'));
        },
      }));
    },
    forwarded: 'image_generation.partial_image',
  },
])('/v1/images/generations forwards and records $name as a failed request-only stream', async ({ body, forwarded }) => {
  const { apiKey, repo } = await setupAppTest();
  await registerImagesUpstream(repo);
  await withMockedFetch(
    () => body(),
    async () => {
      const response = await requestGenerationStream(apiKey.key);
      assertEquals(response.status, 200);
      assertEquals((await response.text()).includes(forwarded), true);
    },
  );
  await assertFailedStreamSettlement(repo);
});

test('/v1/images/generations latches an error event after completed while retaining usage', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerImagesUpstream(repo);
  const wire = [
    imageSseFrame({ type: 'image_generation.completed', b64_json: 'ZmluYWw=', usage: IMAGE_USAGE }),
    imageSseFrame({ type: 'error', error: { message: 'late failure' } }),
  ].join('');

  await withMockedFetch(
    () => imageSseResponse(wire),
    async () => {
      const response = await requestGenerationStream(apiKey.key);
      assertEquals(await response.text(), wire);
    },
  );
  await flushBackground();

  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(tokenCountsFromUsage(usage[0]!), { input: 6, input_image: 4, output_image: 50 });
  const performance = await repo.performance.listAll();
  assertEquals(performance.length, 1);
  assertEquals(performance[0]?.errorsNoOutput, 1);
});

test('/v1/images/generations keeps first-terminal usage when a duplicate completed event fails the stream', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  await registerImagesUpstream(repo);
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);
  const wire = [
    imageSseFrame({ type: 'image_generation.completed', b64_json: 'Zmlyc3Q=', usage: IMAGE_USAGE }),
    imageSseFrame({
      type: 'image_generation.completed',
      b64_json: 'ZHVwbGljYXRl',
      usage: {
        total_tokens: 4,
        input_tokens: 2,
        output_tokens: 2,
        input_tokens_details: { text_tokens: 1, image_tokens: 1 },
      },
    }),
  ].join('');

  await withMockedFetch(
    () => imageSseResponse(wire),
    async () => {
      const response = await requestGenerationStream(apiKey.key);
      assertEquals(await response.text(), wire);
    },
  );
  await flushBackground();

  const [usage] = await repo.usage.listAll();
  assertEquals(tokenCountsFromUsage(usage), { input: 6, input_image: 4, output_image: 50 });
  const [performance] = await repo.performance.listAll();
  assertEquals(performance.errorsNoOutput, 1);
  assertEquals(dumps.stored[0]?.record.meta.error?.kind, 'failed');
});

test('/v1/images response handling follows upstream media type and preserves streaming status', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerImagesUpstream(repo);

  await withMockedFetch(
    () => jsonResponse({ data: [{ b64_json: 'anNvbg==' }], usage: IMAGE_USAGE }),
    async () => {
      const response = await requestGenerationStream(apiKey.key);
      assertEquals(response.headers.get('content-type'), 'application/json');
      assertEquals((await response.json()).data[0].b64_json, 'anNvbg==');
      await flushBackground();
    },
  );

  const streamWire = imageSseFrame({ type: 'image_generation.completed', b64_json: 'c3RyZWFt', usage: IMAGE_USAGE });
  await withMockedFetch(
    () => new Response(streamWire, { status: 201, headers: { 'content-type': 'text/event-stream', 'x-request-id': 'stream-status' } }),
    async () => {
      const response = await requestApp('/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'gpt-image-2', prompt: 'media-driven' }),
      });
      assertEquals(response.status, 201);
      assertEquals(response.headers.get('x-request-id'), 'stream-status');
      assertEquals(await response.text(), streamWire);
      await flushBackground();
    },
  );
});

test('/v1/images/generations preserves exhausted upstream errors and records request-only settlement', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerImagesUpstream(repo);
  await withMockedFetch(
    () => new Response('rate limited', {
      status: 429,
      headers: { 'retry-after': '7', 'set-cookie': 'secret=1', 'x-request-id': 'image-rate-limit' },
    }),
    async () => {
      const response = await requestGenerationStream(apiKey.key);
      assertEquals(response.status, 429);
      assertEquals(response.headers.get('retry-after'), '7');
      assertEquals(response.headers.get('x-request-id'), 'image-rate-limit');
      assertEquals(response.headers.get('set-cookie'), null);
      assertEquals(await response.text(), 'rate limited');
    },
  );
  await assertFailedStreamSettlement(repo);
});

test('/v1/images/generations dump renders stream frames and terminal image-token accounting', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  await registerImagesUpstream(repo);
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);
  const wire = [
    imageSseFrame({ type: 'image_generation.partial_image', b64_json: 'cGFydGlhbA==', partial_image_index: 0 }),
    imageSseFrame({ type: 'image_generation.completed', b64_json: 'ZmluYWw=', usage: IMAGE_USAGE }),
  ].join('');

  await withMockedFetch(
    () => new Response(wire, { status: 201, headers: { 'content-type': 'text/event-stream' } }),
    async () => {
      const response = await requestGenerationStream(apiKey.key);
      assertEquals(response.status, 201);
      assertEquals(await response.text(), wire);
    },
  );
  await flushBackground();

  assertEquals(dumps.stored.length, 1);
  const dump = dumps.stored[0]!.record;
  assertEquals(dump.meta.status, 201);
  assertEquals(dump.meta.error, null);
  assertEquals(dump.meta.inputTokens, 10);
  assertEquals(dump.meta.outputTokens, 50);
  assertEquals(dump.meta.responseBytes, new TextEncoder().encode(wire).byteLength);
  assertEquals(dump.response.body.type, 'stream');
  if (dump.response.body.type === 'stream') {
    assertEquals(dump.response.body.events.map(entry =>
      entry.frame.type === 'event' && typeof entry.frame.event === 'object' && entry.frame.event !== null
        ? (entry.frame.event as { type?: unknown }).type
        : null), ['image_generation.partial_image', 'image_generation.completed']);
  }
});

test('/v1/images/generations returns 502 and records failure for a bodyless stream response', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerImagesUpstream(repo);
  await withMockedFetch(
    () => imageSseResponse(null),
    async () => {
      const response = await requestGenerationStream(apiKey.key);
      assertEquals(response.status, 502);
      assertEquals(response.headers.get('x-provider-trace'), 'image-trace');
      assertEquals(await response.json(), { error: { message: 'Upstream returned a streaming response with no body.', type: 'api_error' } });
    },
  );
  await assertFailedStreamSettlement(repo);
});

test('/v1/images/generations downstream cancellation drains the provider response without aborting it', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  await registerImagesUpstream(repo);
  const dumps = installDumpStubs(initDumpStore, initDumpBroker);
  const encoder = new TextEncoder();
  let providerSignal!: AbortSignal;
  let upstreamCanceled = false;
  let upstreamController!: ReadableStreamDefaultController<Uint8Array>;

  await withMockedFetch(
    request => {
      providerSignal = request.signal;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          upstreamController = controller;
          controller.enqueue(encoder.encode(imageSseFrame({ type: 'image_generation.partial_image', b64_json: 'cGFydGlhbA==' })));
        },
        cancel() {
          upstreamCanceled = true;
        },
      });
      return imageSseResponse(body);
    },
    async () => {
      const response = await requestGenerationStream(apiKey.key);
      assertEquals(response.headers.get('x-provider-trace'), 'image-trace');
      const reader = response.body!.getReader();
      const first = await reader.read();
      assertEquals(new TextDecoder().decode(first.value).includes('image_generation.partial_image'), true);
      await reader.cancel('client left');
      assertEquals(providerSignal.aborted, false);
      assertEquals(upstreamCanceled, false);
      upstreamController.enqueue(encoder.encode(imageSseFrame({
        type: 'image_generation.completed',
        b64_json: 'ZmluYWw=',
        usage: IMAGE_USAGE,
      })));
      upstreamController.close();
    },
  );

  await flushBackground();
  assertEquals(providerSignal.aborted, false);
  assertEquals(upstreamCanceled, false);
  const [usage] = await repo.usage.listAll();
  assertEquals(tokenCountsFromUsage(usage), { input: 6, input_image: 4, output_image: 50 });
  const [performance] = await repo.performance.listAll();
  assertEquals(performance.neutral, 1);
  assertEquals(performance.errorsNoOutput, 0);
  assertEquals(dumps.stored.length, 1);
  const dump = dumps.stored[0]!.record;
  assertEquals(dump.meta.error, null);
  assertEquals(dump.meta.inputTokens, 10);
  assertEquals(dump.meta.outputTokens, 50);
  assertEquals(dump.response.body.type, 'stream');
  if (dump.response.body.type === 'stream') {
    assertEquals(dump.response.body.events.map(entry =>
      entry.frame.type === 'event' && typeof entry.frame.event === 'object' && entry.frame.event !== null
        ? (entry.frame.event as { type?: unknown }).type
        : null), ['image_generation.partial_image', 'image_generation.completed']);
  }
});
