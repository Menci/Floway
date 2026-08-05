import { test, vi } from 'vitest';

import type { InMemoryRepo } from '../../repo/memory.ts';
import { buildCustomUpstreamRecord, flushAsyncWork, requestApp, setupAppTest } from '../../test-utils/app.ts';
import type { ModelPricing } from '@floway-dev/protocols/common';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { withMockedFetch, assertEquals, assertExists } from '@floway-dev/test-utils';

const buildAudioUpstream = (
  id: string,
  name: string,
  sortOrder: number,
  baseUrl: string,
  upstreamModelId: string,
  pricing?: ModelPricing,
) => buildCustomUpstreamRecord({
  id,
  name,
  sortOrder,
  config: {
    baseUrl,
    authStyle: 'bearer',
    ingressHeadersRules: [],
    apiKey: `sk-${id}`,
    endpoints: {},
    modelsFetch: { enabled: false },
    models: [{
      upstreamModelId,
      publicModelId: 'gpt-4o-transcribe',
      kind: 'transcription',
      endpoints: { audioTranscriptions: {} },
      ...(pricing ? { pricing } : {}),
    }],
  },
});

const registerAudioModel = async (repo: InMemoryRepo, pricing?: ModelPricing): Promise<void> => {
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await repo.upstreams.save(buildAudioUpstream(
    'up_audio',
    'Audio Provider',
    1,
    'https://audio.example.com',
    'gpt-4o-transcribe-upstream',
    pricing,
  ));
};

const appendTranscriptionFile = (form: FormData): void => {
  form.append('file', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/wav' }), 'meeting.wav');
};

const transcriptionForm = (fields: readonly [string, string][] = []): FormData => {
  const form = new FormData();
  // File intentionally precedes model: multipart field order is unconstrained.
  appendTranscriptionFile(form);
  for (const [name, value] of fields) form.append(name, value);
  form.append('model', 'gpt-4o-transcribe');
  return form;
};

const assertFailedRequestOnlySettlement = async (repo: InMemoryRepo): Promise<void> => {
  await flushAsyncWork();
  const usage = await repo.usage.listAll();
  assertEquals(usage.length, 1);
  assertEquals(usage[0]?.requests, 1);
  assertEquals(usage[0]?.metrics, []);
  const performance = await repo.performance.listAll();
  assertEquals(performance.length, 1);
  assertEquals(performance[0]?.requests, 1);
  assertEquals(performance[0]?.errorsNoOutput, 1);
};

test('/v1/audio/transcriptions rejects malformed multipart and invalid field types before upstream dispatch', async () => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo);
  const missingModel = new FormData();
  appendTranscriptionFile(missingModel);
  const emptyModel = new FormData();
  appendTranscriptionFile(emptyModel);
  emptyModel.append('model', '');
  const fileModel = new FormData();
  appendTranscriptionFile(fileModel);
  fileModel.append('model', new Blob(['gpt-4o-transcribe'], { type: 'text/plain' }), 'model.txt');
  const mixedModelValues = transcriptionForm();
  mixedModelValues.append('model', new Blob(['alternate'], { type: 'text/plain' }), 'model.txt');
  const duplicateModels = transcriptionForm();
  duplicateModels.append('model', 'alternate');
  const missingFile = new FormData();
  missingFile.append('model', 'gpt-4o-transcribe');
  const stringFile = new FormData();
  stringFile.append('model', 'gpt-4o-transcribe');
  stringFile.append('file', 'not-a-file');
  const mixedFiles = transcriptionForm();
  mixedFiles.append('file', 'not-a-file');

  const cases: readonly {
    readonly name: string;
    readonly body: BodyInit;
    readonly contentType?: string;
    readonly message: string;
  }[] = [
    {
      name: 'non-multipart body',
      body: '{}',
      contentType: 'application/json',
      message: 'Audio transcription request body must use multipart/form-data.',
    },
    {
      name: 'malformed multipart syntax',
      body: 'not a multipart body',
      contentType: 'multipart/form-data; boundary=broken',
      message: 'Audio transcription request body must be valid multipart/form-data.',
    },
    { name: 'missing model', body: missingModel, message: 'Audio transcription request body must include a model field.' },
    { name: 'empty model', body: emptyModel, message: 'Audio transcription request body must include a model field.' },
    { name: 'file-valued model', body: fileModel, message: 'Audio transcription request body must include a model field.' },
    { name: 'mixed model values', body: mixedModelValues, message: 'Audio transcription request body must include a model field.' },
    { name: 'duplicate model values', body: duplicateModels, message: 'Audio transcription request body must include a model field.' },
    { name: 'missing file', body: missingFile, message: 'Audio transcription request body must include a file upload.' },
    { name: 'string-valued file', body: stringFile, message: 'Audio transcription request body must include a file upload.' },
    { name: 'mixed file values', body: mixedFiles, message: 'Audio transcription request body must include a file upload.' },
  ];
  let upstreamCalls = 0;
  await withMockedFetch(
    () => {
      upstreamCalls += 1;
      return Response.json({ text: 'unexpected dispatch' });
    },
    async () => {
      for (const invalid of cases) {
        const headers: Record<string, string> = { 'x-api-key': apiKey.key };
        if (invalid.contentType !== undefined) headers['content-type'] = invalid.contentType;
        const response = await requestApp('/v1/audio/transcriptions', {
          method: 'POST',
          headers,
          body: invalid.body,
        });
        assertEquals(response.status, 400, invalid.name);
        assertEquals(await response.json(), {
          error: { message: invalid.message, type: 'api_error' },
        }, invalid.name);
      }
    },
  );
  assertEquals(upstreamCalls, 0);
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
        headers: { 'content-type': 'Application/Vnd.OpenAI+JSON; charset=utf-8', 'x-provider-trace': 'trace-a' },
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

test('/v1/audio/transcriptions rebuilds the complete multipart body for a failover candidate', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await repo.upstreams.save(buildAudioUpstream(
    'up_audio_first',
    'First Audio Provider',
    1,
    'https://audio-first.example.com',
    'transcribe-first',
  ));
  await repo.upstreams.save(buildAudioUpstream(
    'up_audio_second',
    'Second Audio Provider',
    2,
    'https://audio-second.example.com',
    'transcribe-second',
  ));
  let firstForm: FormData | undefined;
  let secondForm: FormData | undefined;

  await withMockedFetch(
    async request => {
      const host = new URL(request.url).hostname;
      if (host === 'audio-first.example.com') {
        firstForm = await request.formData();
        return new Response('temporarily unavailable', { status: 503 });
      }
      if (host === 'audio-second.example.com') {
        secondForm = await request.formData();
        return Response.json({ text: 'recovered transcript' });
      }
      throw new Error(`Unexpected audio failover fetch: ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'x-api-key': apiKey.key },
        body: transcriptionForm([
          ['language', 'en'],
          ['timestamp_granularities[]', 'word'],
          ['timestamp_granularities[]', 'segment'],
          ['temperature', '0.2'],
        ]),
      });
      assertEquals(response.status, 200);
      assertEquals(await response.json(), { text: 'recovered transcript' });
    },
  );

  assertExists(firstForm);
  assertEquals(firstForm.get('model'), 'transcribe-first');
  assertExists(secondForm);
  assertEquals(secondForm.get('model'), 'transcribe-second');
  assertEquals(secondForm.get('language'), 'en');
  assertEquals(secondForm.get('temperature'), '0.2');
  assertEquals(secondForm.getAll('timestamp_granularities[]'), ['word', 'segment']);
  const replayedFile = secondForm.get('file');
  assertEquals(replayedFile instanceof File, true);
  assertEquals((replayedFile as File).name, 'meeting.wav');
  assertEquals((replayedFile as File).type, 'audio/wav');
  assertEquals(new Uint8Array(await (replayedFile as File).arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
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
    assertEquals(warnSpy.mock.calls.some(call => typeof call[0] === 'string' && call[0].includes('failed to observe 2xx upstream body for /audio/transcriptions')), true);
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
    ].join('\n'), { status: 201, headers: { 'content-type': 'Text/Event-Stream; charset=utf-8', 'x-stream-trace': 'trace-sse' } }),
    async () => {
      const response = await requestApp('/v1/audio/transcriptions', {
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

test.each([
  {
    name: 'malformed SSE JSON',
    createFixture: () => ({
      response: new Response([
        'data: {"type":"transcript.text.delta","delta":"partial"}',
        '',
        'data: {not-json}',
        '',
        'data: {"type":"transcript.text.done","text":"complete","usage":{"type":"tokens","input_tokens":3,"output_tokens":2,"total_tokens":5}}',
        '',
      ].join('\n'), { headers: { 'content-type': 'text/event-stream' } }),
      verify: () => undefined,
    }),
    forwarded: ['transcript.text.delta', '{not-json}', 'transcript.text.done'],
  },
  {
    name: 'an upstream body read error',
    createFixture: () => {
      const encoder = new TextEncoder();
      let pulled = false;
      let readErrorTriggered = false;
      return {
        response: new Response(new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!pulled) {
              pulled = true;
              controller.enqueue(encoder.encode('data: {"type":"transcript.text.delta","delta":"partial"}\n\n'));
              return;
            }
            readErrorTriggered = true;
            controller.error(new Error('upstream audio stream failed'));
          },
        }), { headers: { 'content-type': 'text/event-stream' } }),
        verify: () => assertEquals(readErrorTriggered, true),
      };
    },
    forwarded: ['transcript.text.delta', 'partial'],
  },
])('/v1/audio/transcriptions forwards $name and records failed request-only settlement', async ({ createFixture, forwarded }) => {
  const { apiKey, repo } = await setupAppTest();
  await registerAudioModel(repo);
  const fixture = createFixture();
  await withMockedFetch(
    () => fixture.response,
    async () => {
      const response = await requestApp('/v1/audio/transcriptions', {
        method: 'POST', headers: { 'x-api-key': apiKey.key }, body: transcriptionForm([['stream', 'true']]),
      });
      assertEquals(response.status, 200);
      const wire = await response.text();
      for (const fragment of forwarded) assertEquals(wire.includes(fragment), true);
    },
  );
  fixture.verify();
  await assertFailedRequestOnlySettlement(repo);
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
