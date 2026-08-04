import { test, vi } from 'vitest';

import type { InMemoryRepo } from '../../repo/memory.ts';
import { flushAsyncWork, MOCKED_FETCH_EGRESS, requestApp, setupAppTest } from '../../test-utils/app.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { withMockedFetch, assertEquals, assertExists } from '@floway-dev/test-utils';

const registerAudioModel = async (
  repo: InMemoryRepo,
  pricing?: ModelPricing,
): Promise<void> => {
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await repo.upstreams.save({
    id: 'up_audio',
    kind: 'custom',
    name: 'Audio Provider',
    enabled: true,
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
      authStyle: 'bearer',
      apiKey: 'sk-audio',
      endpoints: {},
      modelsFetch: { enabled: false },
      models: [{
        upstreamModelId: 'gpt-4o-transcribe-upstream',
        publicModelId: 'gpt-4o-transcribe',
        kind: 'transcription',
        endpoints: { audioTranscriptions: {} },
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

test('/v1/audio/transcriptions requires multipart model and file fields', async () => {
  const { apiKey } = await setupAppTest();
  const json = await requestApp('/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey.key },
    body: '{}',
  });
  assertEquals(json.status, 400);

  const missingFile = new FormData();
  missingFile.append('model', 'gpt-4o-transcribe');
  const noFile = await requestApp('/v1/audio/transcriptions', {
    method: 'POST', headers: { 'x-api-key': apiKey.key }, body: missingFile,
  });
  assertEquals(noFile.status, 400);
});

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
        headers: { 'content-type': 'application/json', 'x-provider-trace': 'trace-a' },
      });
    },
    async () => {
      const response = await requestApp('/v1/audio/transcriptions', {
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

  await flushAsyncWork();
  const [usage] = await repo.usage.listAll();
  assertEquals(usage.requests, 1);
  assertEquals(usage.metrics, [
    { metric: 'input_tokens', quantity: '4', unitPrice: '0.000001' },
    { metric: 'input_audio_tokens', quantity: '10', unitPrice: '0.000002' },
    { metric: 'output_tokens', quantity: '45', unitPrice: '0.000004' },
  ]);
});

test('/v1/audio/transcriptions forwards VTT verbatim and records request-only usage', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo);
  await withMockedFetch(
    () => new Response('WEBVTT\n\n00:00.000 --> 00:01.000\nhello', {
      headers: { 'content-type': 'text/vtt', 'x-subtitle-source': 'upstream' },
    }),
    async () => {
      const response = await requestApp('/v1/audio/transcriptions', {
        method: 'POST', headers: { 'x-api-key': apiKey.key }, body: transcriptionForm([['response_format', 'vtt']]),
      });
      assertEquals(response.headers.get('content-type'), 'text/vtt');
      assertEquals(response.headers.get('x-subtitle-source'), 'upstream');
      assertEquals(await response.text(), 'WEBVTT\n\n00:00.000 --> 00:01.000\nhello');
    },
  );
  await flushAsyncWork();
  const [usage] = await repo.usage.listAll();
  assertEquals(usage.requests, 1);
  assertEquals(usage.metrics, []);
});

test('/v1/audio/transcriptions skips JSON parsing for text responses without warning', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await withMockedFetch(
      () => new Response('plain transcript', { headers: { 'content-type': 'text/plain' } }),
      async () => {
        const response = await requestApp('/v1/audio/transcriptions', {
          method: 'POST', headers: { 'x-api-key': apiKey.key }, body: transcriptionForm([['response_format', 'text']]),
        });
        assertEquals(await response.text(), 'plain transcript');
      },
    );
    assertEquals(warnSpy.mock.calls.length, 0);
  } finally {
    warnSpy.mockRestore();
  }
});

test('/v1/audio/transcriptions warns on malformed declared JSON while forwarding it raw', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await withMockedFetch(
      () => new Response('{not-json', { headers: { 'content-type': 'application/json' } }),
      async () => {
        const response = await requestApp('/v1/audio/transcriptions', {
          method: 'POST', headers: { 'x-api-key': apiKey.key }, body: transcriptionForm(),
        });
        assertEquals(response.status, 200);
        assertEquals(await response.text(), '{not-json');
      },
    );
    await flushAsyncWork();
    const [usage] = await repo.usage.listAll();
    assertEquals(usage.requests, 1);
    assertEquals(usage.metrics, []);
    assertEquals(warnSpy.mock.calls.some(call => typeof call[0] === 'string' && call[0].includes('failed to parse 2xx upstream body for /audio/transcriptions')), true);
  } finally {
    warnSpy.mockRestore();
  }
});

test('/v1/audio/transcriptions preserves unknown future usage metrics as request-only', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo);
  const upstreamBody = { text: 'hello', usage: { type: 'future_metric', samples: 42 } };
  await withMockedFetch(
    () => Response.json(upstreamBody),
    async () => {
      const response = await requestApp('/v1/audio/transcriptions', {
        method: 'POST', headers: { 'x-api-key': apiKey.key }, body: transcriptionForm(),
      });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), upstreamBody);
    },
  );
  await flushAsyncWork();
  const [usage] = await repo.usage.listAll();
  assertEquals(usage.requests, 1);
  assertEquals(usage.metrics, []);
});

test('/v1/audio/transcriptions preserves malformed declared usage and records request-only telemetry', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo);
  const upstreamBody = { text: 'hello', usage: { type: 'duration', seconds: 'invalid' } };
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await withMockedFetch(
      () => Response.json(
        upstreamBody,
        { headers: { 'x-provider-trace': 'malformed-usage', 'set-cookie': 'upstream-session=secret' } },
      ),
      async () => {
        const response = await requestApp('/v1/audio/transcriptions', {
          method: 'POST', headers: { 'x-api-key': apiKey.key }, body: transcriptionForm(),
        });
        assertEquals(response.status, 200);
        assertEquals(await response.json(), upstreamBody);
        assertEquals(response.headers.get('x-provider-trace'), 'malformed-usage');
        assertEquals(response.headers.get('set-cookie'), null);
      },
    );
    assertEquals(warnSpy.mock.calls.some(call => typeof call[0] === 'string' && call[0].includes('invalid usage in 2xx upstream response')), true);
  } finally {
    warnSpy.mockRestore();
  }
  await flushAsyncWork();
  const [usage] = await repo.usage.listAll();
  assertEquals(usage.requests, 1);
  assertEquals(usage.metrics, []);
  const [performance] = await repo.performance.listAll();
  assertEquals(performance.neutral, 1);
  assertEquals(performance.errorsNoOutput, 0);
});

test('/v1/audio/transcriptions does not invent a content type for an untyped raw response', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo);
  await withMockedFetch(
    () => new Response(new TextEncoder().encode('plain transcript')),
    async () => {
      const response = await requestApp('/v1/audio/transcriptions', {
        method: 'POST', headers: { 'x-api-key': apiKey.key }, body: transcriptionForm([['response_format', 'text']]),
      });
      assertEquals(response.headers.get('content-type'), null);
      assertEquals(await response.text(), 'plain transcript');
    },
  );
});

test('/v1/audio/transcriptions records duration under the per-second metric', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo, {
    entries: [{ rates: { input_audio_seconds: '0.01' } }],
  });
  await withMockedFetch(
    () => Response.json({ text: 'hello', duration: 91.8, usage: { type: 'duration', seconds: 91 } }),
    async () => {
      const response = await requestApp('/v1/audio/transcriptions', {
        method: 'POST', headers: { 'x-api-key': apiKey.key }, body: transcriptionForm([['response_format', 'verbose_json']]),
      });
      assertEquals(response.status, 200);
      await response.json();
    },
  );
  await flushAsyncWork();
  const [usage] = await repo.usage.listAll();
  assertEquals(usage.metrics, [{ metric: 'input_audio_seconds', quantity: '91', unitPrice: '0.01' }]);
});

test('/v1/audio/transcriptions preserves duration usage unpriced when the model is priced per token', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo, {
    entries: [{ rates: { input_audio_tokens: '0.000002', output_tokens: '0.000004' } }],
  });
  await withMockedFetch(
    () => Response.json({ text: 'hello', usage: { type: 'duration', seconds: 75 } }),
    async () => {
      const response = await requestApp('/v1/audio/transcriptions', {
        method: 'POST', headers: { 'x-api-key': apiKey.key }, body: transcriptionForm(),
      });
      assertEquals(response.status, 200);
      await response.json();
    },
  );
  await flushAsyncWork();
  const [usage] = await repo.usage.listAll();
  assertEquals(usage.requests, 1);
  assertEquals(usage.metrics, [{ metric: 'input_audio_seconds', quantity: '75', unitPrice: null }]);
});

test('/v1/audio/transcriptions preserves token usage unpriced when the model is priced per second', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo, {
    entries: [{ rates: { input_audio_seconds: '0.01' } }],
  });
  await withMockedFetch(
    () => Response.json({ text: 'hello', usage: { type: 'tokens', input_tokens: 12, output_tokens: 8, total_tokens: 20 } }),
    async () => {
      const response = await requestApp('/v1/audio/transcriptions', {
        method: 'POST', headers: { 'x-api-key': apiKey.key }, body: transcriptionForm(),
      });
      assertEquals(response.status, 200);
      await response.json();
    },
  );
  await flushAsyncWork();
  const [usage] = await repo.usage.listAll();
  assertEquals(usage.requests, 1);
  assertEquals(usage.metrics, [
    { metric: 'input_tokens', quantity: '12', unitPrice: null },
    { metric: 'output_tokens', quantity: '8', unitPrice: null },
  ]);
});

test('/v1/audio/transcriptions streams through transcript.text.done without adding Chat termination', async () => {
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
    ].join('\n'), { headers: { 'content-type': 'text/event-stream', 'x-stream-trace': 'trace-sse' } }),
    async () => {
      const response = await requestApp('/v1/audio/transcriptions', {
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

test('/v1/audio/transcriptions preserves a terminal stream event with malformed usage', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo);
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await withMockedFetch(
      () => new Response(
        'data: {"type":"transcript.text.done","text":"hello","usage":{"type":"duration","seconds":"invalid"}}\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      ),
      async () => {
        const response = await requestApp('/v1/audio/transcriptions', {
          method: 'POST', headers: { 'x-api-key': apiKey.key }, body: transcriptionForm([['stream', 'true']]),
        });
        assertEquals(response.status, 200);
        assertEquals((await response.text()).includes('transcript.text.done'), true);
      },
    );
    assertEquals(warnSpy.mock.calls.some(call => typeof call[0] === 'string' && call[0].includes('invalid usage in 2xx upstream response')), true);
  } finally {
    warnSpy.mockRestore();
  }
  await flushAsyncWork();
  const [usage] = await repo.usage.listAll();
  assertEquals(usage.metrics, []);
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
      const response = await requestApp('/v1/audio/transcriptions', {
        method: 'POST', headers: { 'x-api-key': apiKey.key }, body: transcriptionForm([['stream', 'true']]),
      });
      const text = await response.text();
      assertEquals(text.includes('transcript.text.done'), true);
      assertEquals(text.includes('[DONE]'), false);
    },
  );
  assertEquals(upstreamCancelled, true);
});

test('/v1/audio/transcriptions treats EOF without transcript.text.done as a failed request', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo);
  await withMockedFetch(
    () => new Response('data: {"type":"transcript.text.delta","delta":"partial"}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    }),
    async () => {
      const response = await requestApp('/v1/audio/transcriptions', {
        method: 'POST', headers: { 'x-api-key': apiKey.key }, body: transcriptionForm([['stream', 'true']]),
      });
      assertEquals(response.status, 200);
      await response.text();
    },
  );
  await flushAsyncWork();
  const [usage] = await repo.usage.listAll();
  assertEquals(usage.requests, 1);
  const [performance] = await repo.performance.listAll();
  assertEquals(performance.errorsNoOutput, 1);
});

test('/v1/audio/transcriptions counts a bodyless SSE response as a failed request', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo);
  await withMockedFetch(
    () => new Response(null, { headers: { 'content-type': 'text/event-stream', 'x-empty-trace': 'empty-sse' } }),
    async () => {
      const response = await requestApp('/v1/audio/transcriptions', {
        method: 'POST', headers: { 'x-api-key': apiKey.key }, body: transcriptionForm([['stream', 'true']]),
      });
      assertEquals(response.status, 502);
      assertEquals(response.headers.get('x-empty-trace'), 'empty-sse');
    },
  );
  await flushAsyncWork();
  const [usage] = await repo.usage.listAll();
  assertEquals(usage.requests, 1);
  const [performance] = await repo.performance.listAll();
  assertEquals(performance.errorsNoOutput, 1);
});

test('/v1/audio/transcriptions forwards exhausted upstream errors and records the request', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo);
  await withMockedFetch(
    () => new Response(JSON.stringify({ error: { message: 'bad audio' } }), {
      status: 422,
      headers: { 'content-type': 'application/json', 'retry-after': '4', 'x-error-trace': 'trace-error' },
    }),
    async () => {
      const response = await requestApp('/v1/audio/transcriptions', {
        method: 'POST', headers: { 'x-api-key': apiKey.key }, body: transcriptionForm(),
      });
      assertEquals(response.status, 422);
      assertEquals(response.headers.get('retry-after'), '4');
      assertEquals(response.headers.get('x-error-trace'), 'trace-error');
      assertEquals(await response.json(), { error: { message: 'bad audio' } });
    },
  );
  await flushAsyncWork();
  const [usage] = await repo.usage.listAll();
  assertEquals(usage.requests, 1);
  assertEquals(usage.metrics, []);
  const [performance] = await repo.performance.listAll();
  assertEquals(performance.errorsNoOutput, 1);
});
