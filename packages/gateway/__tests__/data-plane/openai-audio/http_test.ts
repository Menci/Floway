import { expect, test } from 'vitest';

import type { InMemoryRepo } from '../../repo/memory.ts';
import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { MOCKED_FETCH_EGRESS, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { flushBackground } from '../../test-utils/background-tracker.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { withMockedFetch, assertEquals, assertExists } from '@floway-dev/test-utils';

const saveAudioModel = async (
  repo: InMemoryRepo,
  { id, host, sortOrder, pricing }: { id: string; host: string; sortOrder: number; pricing: ModelPricing | undefined },
): Promise<void> => {
  await saveUpstreamForTest(repo.upstreams, {
    id,
    kind: 'custom',
    name: 'Audio Provider',
    enabled: true,
    usageRefreshIntervalMinutes: 0,
    sortOrder,
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
      baseUrl: `https://${host}`,
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

const registerAudioModel = async (repo: InMemoryRepo, pricing?: ModelPricing): Promise<void> => {
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await saveAudioModel(repo, { id: 'up_audio', host: 'audio.example.com', sortOrder: 1, pricing });
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

  await withMockedFetch(
    async request => {
      assertEquals(new URL(request.url).pathname, '/v1/audio/transcriptions');
      upstreamForm = await request.formData();
      return new Response(JSON.stringify({
        text: 'hello world',
        usage: { type: 'tokens', input_tokens: 14, input_token_details: { text_tokens: 4, audio_tokens: 10 }, output_tokens: 45, total_tokens: 59 },
      }), {
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
      assertEquals(await response.json(), {
        text: 'hello world',
        usage: { type: 'tokens', input_tokens: 14, input_token_details: { text_tokens: 4, audio_tokens: 10 }, output_tokens: 45, total_tokens: 59 },
      });
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

  await flushBackground();
  const [usage] = await repo.usage.listAll();
  assertEquals(usage.requests, 1);
  assertEquals(usage.metrics, [
    { metric: 'input_tokens', quantity: '4', unitPrice: '0.000001' },
    { metric: 'input_audio_tokens', quantity: '10', unitPrice: '0.000002' },
    { metric: 'output_tokens', quantity: '45', unitPrice: '0.000004' },
  ]);
});

test('/v1/audio/transcriptions opens SSE with 200 and streams through transcript.text.done', async () => {
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
      assertEquals(response.status, 200);
      assertEquals(response.headers.get('x-stream-trace'), 'trace-sse');
      const stream = await response.text();
      assertEquals(stream.includes('transcript.text.delta'), true);
      assertEquals(stream.includes('transcript.text.done'), true);
      assertEquals(stream.includes('[DONE]'), false);
    },
  );
  await flushBackground();
  const [usage] = await repo.usage.listAll();
  assertEquals(usage.metrics.map(row => ({ metric: row.metric, quantity: row.quantity })), [
    { metric: 'input_tokens', quantity: '3' },
    { metric: 'output_tokens', quantity: '1' },
  ]);
  const [performance] = await repo.performance.listAll();
  assertEquals(performance.neutral, 1);
  assertEquals(performance.errorsNoOutput, 0);
});

test('/v1/audio/transcriptions completes and cancels an upstream kept open after transcript.text.done', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo);
  let upstreamCancelled = false;
  const encoder = new TextEncoder();
  await withMockedFetch(
    () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"transcript.text.delta","delta":"hel"}\n\n'));
        controller.enqueue(encoder.encode('data: {"type":"transcript.text.done","text":"hello"}\n\n'));
      },
      cancel() {
        upstreamCancelled = true;
      },
    }), { headers: { 'content-type': 'text/event-stream' } }),
    async () => {
      const response = await requestAppWithWarmModels('/v1/audio/transcriptions', {
        method: 'POST', headers: { 'x-api-key': apiKey.key }, body: transcriptionForm([['stream', 'true']]),
      });
      const text = await response.text();
      assertEquals(text.includes('transcript.text.done'), true);
      assertEquals(text.includes('[DONE]'), false);
    },
  );
  assertEquals(upstreamCancelled, true);
});

test.each(['read error', 'premature EOF', 'native error'] as const)('/v1/audio/transcriptions sends a data-only failure after partial output on %s', async mode => {
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
      const native = `data: ${JSON.stringify({ error: { code: 'vendor_failure', message } })}\n\n`;
      if (mode === 'read error') upstream.error(new Error(message));
      else if (mode === 'premature EOF') upstream.close();
      else upstream.enqueue(new TextEncoder().encode(native));
      const failure = decode.decode((await reader.read()).value);
      assertEquals(failure.startsWith('data: {"error":'), true);
      if (mode !== 'premature EOF') assertEquals(JSON.parse(failure.slice('data: '.length)).error.message, message);
      if (mode === 'native error') assertEquals(failure, native);
      assertEquals((await reader.read()).done, true);
    },
  );
  await flushBackground();
  expect(await repo.usage.listAll()).toEqual([]);
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
  await flushBackground();
  expect(await repo.usage.listAll()).toEqual([]);
  const [performance] = await repo.performance.listAll();
  assertEquals(performance.errorsNoOutput, 1);
});

test.each([
  {
    name: 'JSON error',
    upstream: () => Response.json({ error: { code: 'vendor_failure' } }, { status: 422, headers: { 'x-upstream': 'second' } }),
    status: 422,
    body: { error: { code: 'vendor_failure' } },
  },
  {
    name: 'text error',
    upstream: () => new Response('temporarily unavailable', { status: 503, headers: { 'x-upstream': 'second' } }),
    status: 503,
    body: { error: { message: 'temporarily unavailable', type: 'api_error' } },
  },
  {
    name: 'WebVTT result',
    upstream: () => new Response('WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nhello\n', {
      status: 201, headers: { 'content-type': 'text/vtt', 'x-upstream': 'second' },
    }),
    status: 201,
    body: 'WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nhello\n',
  },
])('/v1/audio/transcriptions selects the $name and rebuilds the upload for failover', async ({ upstream, status, body }) => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo);
  await saveAudioModel(repo, { id: 'second', host: 'second.example.com', sortOrder: 2, pricing: undefined });
  const calls: string[] = [];

  await withMockedFetch(async request => {
    const url = new URL(request.url);
    expect(url.pathname).toBe('/v1/audio/transcriptions');
    const form = await request.formData();
    expect(form.get('model')).toBe('gpt-4o-transcribe-upstream');
    const file = form.get('file');
    if (!(file instanceof File)) throw new TypeError('Expected the multipart audio file');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3, 4));
    calls.push(url.hostname);
    return url.hostname === 'audio.example.com' ? new Response('first failure', { status: 500 }) : upstream();
  }, async () => {
    const response = await requestAppWithWarmModels('/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'x-api-key': apiKey.key },
      body: transcriptionForm([['response_format', 'vtt']]),
    });
    expect(response.status).toBe(status);
    expect(response.headers.get('x-upstream')).toBe('second');
    if (typeof body === 'string') {
      expect(response.headers.get('content-type')).toBe('text/vtt');
      expect(await response.text()).toBe(body);
    } else {
      expect(await response.json()).toEqual(body);
    }
  });
  await flushBackground();

  expect(calls).toEqual(['audio.example.com', 'second.example.com']);
  expect(await repo.performance.listAll()).toEqual(expect.arrayContaining([
    expect.objectContaining({ upstream: 'up_audio', operation: 'audio_transcription', requests: 1, errorsNoOutput: 1 }),
    expect.objectContaining({ upstream: 'second', operation: 'audio_transcription', requests: 1, errorsNoOutput: status === 201 ? 0 : 1 }),
  ]));
  expect(await repo.usage.listAll()).toMatchObject(status === 201 ? [{ upstream: 'second', requests: 1, metrics: [] }] : []);
});
