import { test, vi } from 'vitest';

import type { InMemoryRepo } from '../../repo/memory.ts';
import { buildCustomUpstreamRecord, flushAsyncWork, requestApp, setupAppTest } from '../../test-utils/app.ts';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { withMockedFetch, assertEquals, assertExists } from '@floway-dev/test-utils';

// The upstream is declared rather than discovered: both images endpoints are named on one
// manual model row, so nothing in these cases depends on the id heuristics that infer a
// catalog's capabilities.
const registerImagesModel = async (repo: InMemoryRepo): Promise<void> => {
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_images',
    name: 'Image Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://images.example.com',
      authStyle: 'bearer',
      ingressHeadersRules: [],
      apiKey: 'sk-images',
      endpoints: {},
      modelsFetch: { enabled: false },
      models: [{
        upstreamModelId: 'gpt-image-2-upstream',
        publicModelId: 'gpt-image-2',
        kind: 'image',
        endpoints: { imagesGenerations: {}, imagesEdits: {} },
      }],
    },
  }));
};

const PARTIAL = 'event: image_generation.partial_image\ndata: {"type":"image_generation.partial_image","b64_json":"UDA=","partial_image_index":0}\n\n';
const COMPLETED = 'event: image_generation.completed\ndata: {"type":"image_generation.completed","b64_json":"RklO","usage":{"total_tokens":100,"input_tokens":50,"output_tokens":50,"input_tokens_details":{"text_tokens":10,"image_tokens":40}}}\n\n';

const sseResponse = (body: string, headers: Record<string, string> = {}): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });

test('/v1/images/generations answers a streaming request with the upstream events as SSE', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerImagesModel(repo);
  let forwarded: Record<string, unknown> | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'images.example.com' && url.pathname === '/v1/images/generations') {
        forwarded = await request.json() as Record<string, unknown>;
        return sseResponse(PARTIAL + COMPLETED, { 'x-image-trace': 'trace-stream', 'set-cookie': 'upstream-session=secret' });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a shiba in space', stream: true, partial_images: 1 }),
      });
      assertEquals(response.status, 200);
      assertEquals(response.headers.get('content-type'), 'text/event-stream');
      // Vendor traces stay visible; an upstream session does not.
      assertEquals(response.headers.get('x-image-trace'), 'trace-stream');
      assertEquals(response.headers.get('set-cookie'), null);

      const stream = await response.text();
      assertEquals(stream.includes('event: image_generation.partial_image'), true);
      assertEquals(stream.includes('"partial_image_index":0'), true);
      assertEquals(stream.includes('event: image_generation.completed'), true);
      assertEquals(stream.includes('"b64_json":"RklO"'), true);
      // This protocol ends at its completed event; the sentinel the chat dialects use is not
      // part of it and is not invented here.
      assertEquals(stream.includes('[DONE]'), false);
    },
  );

  // The flag rides to the upstream exactly as the client wrote it — the gateway asks for the
  // stream the client asked for, having no usage chunk of its own to turn on.
  assertExists(forwarded);
  assertEquals(forwarded.stream, true);
  assertEquals(forwarded.partial_images, 1);
  assertEquals(forwarded.model, 'gpt-image-2-upstream');
});

test('/v1/images/generations answers a non-streaming request with the JSON object', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerImagesModel(repo);

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'images.example.com' && url.pathname === '/v1/images/generations') {
        return Promise.resolve(Response.json({ data: [{ b64_json: 'aGVsbG8=' }], usage: { input_tokens: 10, output_tokens: 50 } }));
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a shiba in space', stream: false }),
      });
      assertEquals(response.status, 200);
      assertEquals(response.headers.get('content-type'), 'application/json');
      assertEquals(await response.json(), { data: [{ b64_json: 'aGVsbG8=' }], usage: { input_tokens: 10, output_tokens: 50 } });
    },
  );
});

test('/v1/images/generations bills a stream from the usage its completed event reported, once', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerImagesModel(repo);

  await withMockedFetch(
    () => Promise.resolve(sseResponse(PARTIAL + COMPLETED)),
    async () => {
      const response = await requestApp('/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a shiba in space', stream: true }),
      });
      assertEquals(response.status, 200);
      await response.text();
    },
  );

  await flushAsyncWork();
  const rows = await repo.usage.listAll();
  assertEquals(rows.length, 1);
  // The numbers arrive with the completed event, long after the run answered, so a row that
  // carries them is a row settled from the promise the run handed up. Settling in the stage as
  // well would have counted the request twice.
  assertEquals(rows[0]?.requests, 1);
  assertEquals(rows[0]?.metrics.map(row => ({ metric: row.metric, quantity: row.quantity })), [
    { metric: 'input_tokens', quantity: '10' },
    { metric: 'input_image_tokens', quantity: '40' },
    { metric: 'output_tokens', quantity: '50' },
  ]);
  const [performance] = await repo.performance.listAll();
  assertEquals(performance?.requests, 1);
});

test('/v1/images/generations answers a refused stream in the upstream status and words', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerImagesModel(repo);

  await withMockedFetch(
    () => Promise.resolve(new Response(JSON.stringify({ error: { message: 'Rate limit reached for images.', code: 'rate_limit_exceeded' } }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '7', 'x-error-trace': 'trace-refused' },
    })),
    async () => {
      const response = await requestApp('/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a shiba in space', stream: true }),
      });
      // A request that asked to stream but was refused is answered as the refusal it is.
      assertEquals(response.status, 429);
      assertEquals(response.headers.get('content-type'), 'application/json');
      assertEquals(response.headers.get('retry-after'), '7');
      assertEquals(response.headers.get('x-error-trace'), 'trace-refused');
      assertEquals(await response.json(), { error: { message: 'Rate limit reached for images.', code: 'rate_limit_exceeded' } });
    },
  );

  await flushAsyncWork();
  const [performance] = await repo.performance.listAll();
  assertEquals(performance?.errorsNoOutput, 1);
});

test('/v1/images/generations completes and cancels an upstream kept open after the completed event', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerImagesModel(repo);
  let upstreamCancelled = false;
  const encoder = new TextEncoder();

  await withMockedFetch(
    () => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(PARTIAL));
        controller.enqueue(encoder.encode(COMPLETED));
        // Deliberately never closed: the image is done and the connection is not.
      },
      cancel() {
        upstreamCancelled = true;
      },
    }), { headers: { 'content-type': 'text/event-stream' } })),
    async () => {
      const response = await requestApp('/v1/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
        body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a shiba in space', stream: true }),
      });
      const stream = await response.text();
      assertEquals(stream.includes('event: image_generation.completed'), true);
    },
  );

  assertEquals(upstreamCancelled, true);
});

test('/v1/images/generations fails a stream that ended without a completed event', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerImagesModel(repo);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  try {
    await withMockedFetch(
      () => Promise.resolve(sseResponse(PARTIAL)),
      async () => {
        const response = await requestApp('/v1/images/generations', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
          body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a shiba in space', stream: true }),
        });
        // The answer had already begun, so what the client keeps is what it was already sent.
        assertEquals(response.status, 200);
        const stream = await response.text();
        assertEquals(stream.includes('event: image_generation.partial_image'), true);
        assertEquals(stream.includes('image_generation.completed'), false);
      },
    );
    // An upstream that sent partial images and no image never answered the request, and the
    // run says so rather than letting a truncated stream read as a complete one.
    assertEquals(
      errorSpy.mock.calls.some(call => call.some(arg => arg instanceof Error && arg.message === 'Images stream ended without a completed event.')),
      true,
    );
  } finally {
    errorSpy.mockRestore();
  }
});

test('/v1/images/edits streams a multipart request, whose stream field arrives as text', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerImagesModel(repo);
  let upstreamForm: FormData | undefined;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'images.example.com' && url.pathname === '/v1/images/edits') {
        upstreamForm = await request.formData();
        return sseResponse(
          'event: image_edit.partial_image\ndata: {"type":"image_edit.partial_image","b64_json":"UDA=","partial_image_index":0}\n\n'
          + 'event: image_edit.completed\ndata: {"type":"image_edit.completed","b64_json":"RklO","usage":{"total_tokens":20,"input_tokens":8,"output_tokens":12,"input_tokens_details":{"text_tokens":3,"image_tokens":5}}}\n\n',
        );
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const form = new FormData();
      form.append('model', 'gpt-image-2');
      form.append('prompt', 'replace the sky');
      form.append('stream', 'true');
      form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'photo.png');
      const response = await requestApp('/v1/images/edits', {
        method: 'POST', headers: { 'x-api-key': apiKey.key }, body: form,
      });
      assertEquals(response.status, 200);
      assertEquals(response.headers.get('content-type'), 'text/event-stream');
      const stream = await response.text();
      assertEquals(stream.includes('event: image_edit.partial_image'), true);
      assertEquals(stream.includes('event: image_edit.completed'), true);
    },
  );

  assertExists(upstreamForm);
  assertEquals(upstreamForm.get('stream'), 'true');

  await flushAsyncWork();
  const rows = await repo.usage.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0]?.metrics.map(row => ({ metric: row.metric, quantity: row.quantity })), [
    { metric: 'input_tokens', quantity: '3' },
    { metric: 'input_image_tokens', quantity: '5' },
    { metric: 'output_tokens', quantity: '12' },
  ]);
});
