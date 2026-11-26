import { test } from 'vitest';

import type { InMemoryRepo } from '../../repo/memory.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { flushAsyncWork, MOCKED_FETCH_EGRESS, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { UpstreamTransportError } from '@floway-dev/http';
import type { ModelPricing } from '@floway-dev/protocols/common';
import { withMockedFetch, assertEquals, assertExists } from '@floway-dev/test-utils';

const registerAudioModel = async (
  repo: InMemoryRepo,
  pricing?: ModelPricing,
): Promise<void> => {
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, {
    id: 'up_audio',
    kind: 'custom',
    name: 'Audio Provider',
    enabled: true,
    usageRefreshIntervalMinutes: 0,
    sortOrder: 1,
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: MOCKED_FETCH_EGRESS,
    modelPrefix: null,
    modelsCache: null,
    hue: 210,
    config: {
      baseUrl: 'https://audio.example.com',
      ingressHeadersRules: [],
      apiKey: 'sk-audio',
      endpoints: {},
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [{
        upstreamModelId: 'gpt-4o-transcribe-upstream',
        publicModelId: 'gpt-4o-transcribe',
        kind: 'transcription',
        endpoints: { openaiAudioTranscriptions: {} },
        ...(pricing ? { pricing } : {}),
      }],
    },
  });
};

const transcriptionForm = (fields: readonly [string, string][] = []): FormData => {
  const form = new FormData();
  // File intentionally precedes model: multipart field order is unconstrained.
  form.append('file', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/wav' }), 'meeting.wav');
  for (const [name, value] of fields) form.append(name, value);
  form.append('model', 'gpt-4o-transcribe');
  return form;
};

test('/v1/audio/transcriptions preserves multipart fields, headers, JSON body, and token usage', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo, {
    entries: [{ rates: { input_tokens: '0.000001', input_audio_tokens: '0.000002', output_tokens: '0.000004' } }],
  });
  let upstreamForm: FormData | undefined;
  const upstreamBody = `${JSON.stringify({
    text: 'hello world',
    usage: { type: 'tokens', input_tokens: 14, input_token_details: { text_tokens: 4, audio_tokens: 10 }, output_tokens: 45, total_tokens: 59 },
  }, null, 2)}\n`;

  await withMockedFetch(
    async request => {
      assertEquals(new URL(request.url).pathname, '/v1/audio/transcriptions');
      upstreamForm = await request.formData();
      return new Response(upstreamBody, {
        headers: { 'content-type': 'Application/Vnd.OpenAI+JSON; charset=utf-8', 'x-provider-trace': 'trace-a' },
      });
    },
    async () => {
      const response = await requestAppWithWarmModels('/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'x-api-key': apiKey.key },
        body: transcriptionForm([
          ['language', 'en'],
          ['timestamp_granularities[]', 'word'],
          ['timestamp_granularities[]', 'segment'],
        ]),
      });
      assertEquals(response.status, 200);
      assertEquals(response.headers.get('x-provider-trace'), 'trace-a');
      assertEquals(await response.text(), upstreamBody);
    },
  );

  assertExists(upstreamForm);
  assertEquals(upstreamForm.get('model'), 'gpt-4o-transcribe-upstream');
  assertEquals(upstreamForm.get('language'), 'en');
  assertEquals(upstreamForm.getAll('timestamp_granularities[]'), ['word', 'segment']);
  const file = upstreamForm.get('file');
  assertEquals(file instanceof File, true);
  assertEquals((file as File).name, 'meeting.wav');
  assertEquals((file as File).type, 'audio/wav');
  assertEquals(new Uint8Array(await (file as File).arrayBuffer()), new Uint8Array([1, 2, 3, 4]));

  await flushAsyncWork();
  const [usage] = await repo.usage.listAll();
  assertEquals(usage.requests, 1);
  assertEquals(usage.metrics, [
    { metric: 'input_tokens', quantity: '4', unitPrice: '0.000001' },
    { metric: 'input_audio_tokens', quantity: '10', unitPrice: '0.000002' },
    { metric: 'output_tokens', quantity: '45', unitPrice: '0.000004' },
  ]);
});

test('/v1/audio/transcriptions preserves opaque VTT bytes and their media type', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo);
  const body = 'WEBVTT\r\n\r\n00:00:00.000 --> 00:00:01.000\r\nhello\r\n';
  await withMockedFetch(
    () => new Response(body, { headers: { 'content-type': 'text/vtt', 'x-provider-trace': 'opaque-transcription' } }),
    async () => {
      const response = await requestAppWithWarmModels('/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'x-api-key': apiKey.key },
        body: transcriptionForm([['response_format', 'vtt']]),
      });
      assertEquals(response.status, 200);
      assertEquals(response.headers.get('content-type'), 'text/vtt');
      assertEquals(response.headers.get('x-provider-trace'), 'opaque-transcription');
      assertEquals(await response.text(), body);
    },
  );
});

test('/v1/audio/transcriptions preserves the upstream SSE status and streams through transcript.text.done', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo, {
    entries: [{ rates: { input_audio_tokens: '0.000001', output_tokens: '0.000001' } }],
  });
  await withMockedFetch(
    () => new Response([
      'data: {"type":"transcript.text.delta","delta":"hel"}',
      '',
      'data: {"type":"transcript.text.done","text":"hello","usage":{"type":"tokens","input_tokens":3,"output_tokens":1,"total_tokens":4}}',
      '',
    ].join('\n'), { status: 201, headers: { 'content-type': 'Text/Event-Stream; charset=utf-8', 'x-stream-trace': 'trace-sse' } }),
    async () => {
      const response = await requestAppWithWarmModels('/v1/audio/transcriptions', {
        method: 'POST', headers: { 'x-api-key': apiKey.key }, body: transcriptionForm([['stream', 'true']]),
      });
      assertEquals(response.status, 201);
      assertEquals(response.headers.get('x-stream-trace'), 'trace-sse');
      const stream = await response.text();
      assertEquals(stream.includes('transcript.text.delta'), true);
      assertEquals(stream.includes('transcript.text.done'), true);
      assertEquals(stream.includes('[DONE]'), false);
    },
  );
  await flushAsyncWork();
  const [usage] = await repo.usage.listAll();
  assertEquals(usage.metrics.map(row => ({ metric: row.metric, quantity: row.quantity })), [
    { metric: 'input_tokens', quantity: '3' },
    { metric: 'output_tokens', quantity: '1' },
  ]);
  const [performance] = await repo.performance.listAll();
  assertEquals(performance.neutral, 1);
  assertEquals(performance.errorsNoOutput, 0);
});

test('/v1/audio/transcriptions preserves a named terminal event and finishes after native EOF', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo);
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  let upstreamCancelled = false;
  const encoder = new TextEncoder();
  const terminal = 'event: transcript.text.done\ndata: {"type":"transcript.text.done","text":"hello"}\n\n';
  await withMockedFetch(
    () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        upstream = controller;
        controller.enqueue(encoder.encode('data: {"type":"transcript.text.delta","delta":"hel"}\n\n'));
        controller.enqueue(encoder.encode(terminal));
      },
      cancel() {
        upstreamCancelled = true;
      },
    }), { headers: { 'content-type': 'text/event-stream' } }),
    async () => {
      const response = await requestAppWithWarmModels('/v1/audio/transcriptions', {
        method: 'POST', headers: { 'x-api-key': apiKey.key }, body: transcriptionForm([['stream', 'true']]),
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      assertEquals(decoder.decode((await reader.read()).value).includes('transcript.text.delta'), true);
      assertEquals(decoder.decode((await reader.read()).value), terminal);
      const finished = reader.read();
      const state = await Promise.race([finished.then(() => 'closed'), new Promise(resolve => setImmediate(() => resolve('open')))]);
      assertEquals(state, 'open');
      upstream.close();
      assertEquals((await finished).done, true);
    },
  );
  assertEquals(upstreamCancelled, false);
});

test('/v1/audio/transcriptions treats malformed upstream JSON as failure before billing', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo);
  await withMockedFetch(
    () => new Response('invalid JSON', { headers: { 'content-type': 'application/vnd.openai+json', 'x-provider-trace': 'malformed-transcription' } }),
    async () => {
      const response = await requestAppWithWarmModels('/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'x-api-key': apiKey.key },
        body: transcriptionForm(),
      });
      assertEquals(response.status, 502);
      assertEquals(response.headers.get('x-provider-trace'), 'malformed-transcription');
      const body = await response.json() as { error: { message: string } };
      assertEquals(typeof body.error.message, 'string');
    },
  );
  await flushAsyncWork();
  assertEquals(await repo.usage.listAll(), []);
  const [performance] = await repo.performance.listAll();
  assertEquals(performance.errorsNoOutput, 1);
});

test.each(['read error', 'premature EOF', 'native error', 'named native error'] as const)('/v1/audio/transcriptions sends a failure after partial output on %s', async mode => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo);
  const partial = 'data: {"type":"transcript.text.delta","delta":"partial"}\n\n';
  let upstream!: ReadableStreamDefaultController<Uint8Array>;
  await withMockedFetch(
    () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        upstream = controller;
        controller.enqueue(new TextEncoder().encode(partial));
      },
    }), { headers: { 'content-type': 'text/event-stream' } }),
    async () => {
      const response = await requestAppWithWarmModels('/v1/audio/transcriptions', {
        method: 'POST', headers: { 'x-api-key': apiKey.key }, body: transcriptionForm([['stream', 'true']]),
      });
      assertEquals(response.status, 200);
      const reader = response.body!.getReader();
      const decode = new TextDecoder();
      assertEquals(decode.decode((await reader.read()).value), partial);
      const message = 'upstream transcription read failed';
      const prefix = mode === 'named native error' ? 'event: error\ndata: ' : 'data: ';
      const native = `${prefix}${JSON.stringify({ error: { code: 'vendor_failure', message } })}\n\n`;
      if (mode === 'read error') upstream.error(new UpstreamTransportError(new Error(message)));
      else if (mode === 'premature EOF') upstream.close();
      else upstream.enqueue(new TextEncoder().encode(native));
      const failure = decode.decode((await reader.read()).value);
      assertEquals(failure.startsWith(`${prefix}{"error":`), true);
      if (mode !== 'premature EOF') assertEquals(JSON.parse(failure.slice(prefix.length)).error.message, message);
      if (mode === 'native error' || mode === 'named native error') assertEquals(failure, native);
      assertEquals((await reader.read()).done, true);
    },
  );
  await flushAsyncWork();
  assertEquals(await repo.usage.listAll(), []);
  const [performance] = await repo.performance.listAll();
  assertEquals(performance.errorsNoOutput, 1);
});

test('/v1/audio/transcriptions counts a bodyless SSE response as a failed request', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo);
  await withMockedFetch(
    () => new Response(null, { headers: { 'content-type': 'text/event-stream', 'x-empty-trace': 'empty-sse' } }),
    async () => {
      const response = await requestAppWithWarmModels('/v1/audio/transcriptions', {
        method: 'POST', headers: { 'x-api-key': apiKey.key }, body: transcriptionForm([['stream', 'true']]),
      });
      assertEquals(response.status, 502);
      assertEquals(response.headers.get('x-empty-trace'), 'empty-sse');
    },
  );
  await flushAsyncWork();
  assertEquals(await repo.usage.listAll(), []);
  const [performance] = await repo.performance.listAll();
  assertEquals(performance.errorsNoOutput, 1);
});
