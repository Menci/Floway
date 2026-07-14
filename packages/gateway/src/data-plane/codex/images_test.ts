import { test } from 'vitest';

import { InMemoryRepo } from '../../repo/memory.ts';
import { copilotModels, requestApp, setupAppTest } from '../../test-helpers.ts';
import { initExternalResourceFetcher, initImageProcessor } from '@floway-dev/platform';
import { assertEquals, assertExists, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/wEAAAAASUVORK5CYII=';
const GIF_B64 = 'R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
const bytesFromBase64 = (value: string): Uint8Array => Uint8Array.from(atob(value), character => character.charCodeAt(0));

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
    proxyFallbackList: [],
    modelPrefix: null,
    color: null,
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

test('Codex provider-relative image generation reuses the public JSON route', async () => {
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

test('Codex provider-relative image edits materialize remote images and transcode unsupported raster formats', async () => {
  const { apiKey, repo } = await setupAppTest();
  await saveAzureImages(repo);
  let observedUrl: string | undefined;
  let observedForm: FormData | undefined;
  let observedImageSourceUrl: string | undefined;
  const webpBytes = Uint8Array.of(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);
  initExternalResourceFetcher(url => {
    observedImageSourceUrl = url.href;
    return Promise.resolve(new Response(bytesFromBase64(PNG_B64).buffer as ArrayBuffer, {
      headers: { 'content-type': 'image/png' },
    }));
  });
  initImageProcessor({
    compressToWebp: input => {
      assertEquals([...input.subarray(0, 6)], [...new TextEncoder().encode('GIF89a')]);
      return Promise.resolve(webpBytes);
    },
  });

  await withMockedFetch(
    async request => {
      const control = controlPlaneFetch(request);
      if (control) return control;
      const url = new URL(request.url);
      if (url.hostname === 'example.openai.azure.com') {
        observedUrl = request.url;
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
          quality: 'high',
          images: [
            { image_url: 'https://assets.example/image.png' },
            { image_url: `data:image/gif;base64,${GIF_B64}` },
          ],
        }),
      });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), { data: [{ b64_json: 'ZWRpdA==' }] });
    },
  );

  assertEquals(observedImageSourceUrl, 'https://assets.example/image.png');
  assertEquals(observedUrl?.endsWith('/images/edits?api-version=preview'), true);
  assertExists(observedForm);
  assertEquals(observedForm.get('model'), 'gpt-image-2');
  assertEquals(observedForm.get('prompt'), 'add a red hat');
  assertEquals(observedForm.get('quality'), 'high');
  const images = observedForm.getAll('image[]') as File[];
  assertEquals(images.map(image => image.type), ['image/png', 'image/webp']);
  assertEquals(
    await Promise.all(images.map(image => image.arrayBuffer().then(buffer => [...new Uint8Array(buffer)]))),
    [[...bytesFromBase64(PNG_B64)], [...webpBytes]],
  );
});

test.each([
  ['not-json', 'Codex image edits request body must be valid JSON.'],
  [JSON.stringify({ model: 'gpt-image-2', prompt: 'edit', images: [{ image_url: 'ftp://example.com/image.png' }] }), 'Codex image edits images[0].image_url must be an HTTP(S) URL or a base64 image data URL.'],
  [JSON.stringify({ model: 'gpt-image-2', prompt: '', images: [{ image_url: 'data:image/png;base64,AQID' }] }), 'Codex image edits images[0].image_url must contain a supported raster image.'],
  [JSON.stringify({ model: 'gpt-image-2', prompt: 'edit', images: [] }), 'Codex image edits request body must include at least one image.'],
])('Codex image edits reject malformed input %#', async (body, message) => {
  const { apiKey } = await setupAppTest();
  const response = await requestApp('/azure-api.codex/images/edits', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
    body,
  });
  assertEquals(response.status, 400);
  assertEquals(await response.json(), { error: { message, type: 'api_error' } });
});
