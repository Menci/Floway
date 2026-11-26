import { expect, test } from 'vitest';

import { saveUpstreamForTest } from '../../repo/upstreams.ts';
import { buildCustomUpstreamRecord, flushAsyncWork, requestAppWithWarmModels, setupAppTest } from '../../test-utils/app.ts';
import { withMockedFetch } from '@floway-dev/test-utils';

const setupSpeechTest = async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await saveUpstreamForTest(repo.upstreams, buildCustomUpstreamRecord({
    id: 'up_speech',
    name: 'Speech',
    config: {
      baseUrl: 'https://speech.example.com',
      apiKey: 'speech-key',
      ingressHeadersRules: [],
      endpoints: {},
      modelsFetch: { enabled: false, authStyle: 'bearer' },
      models: [{ upstreamModelId: 'native-speech', publicModelId: 'speech', endpoints: { openaiAudioSpeech: {} } }],
    },
  }));
  return {
    repo,
    post: async (path: string, body: unknown) => await requestAppWithWarmModels(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${apiKey.key}`, 'content-type': 'application/json' },
    }),
  };
};

test('Speech defaults to binary and preserves bytes, media type, and provider headers', async () => {
  const { repo, post } = await setupSpeechTest();
  const bytes = Uint8Array.of(0, 255, 17, 128);
  const payload = { model: 'speech', input: 'Hello', voice: { id: 'custom-voice' }, response_format: 'wav' };
  await withMockedFetch(async request => {
    expect(new URL(request.url).pathname).toBe('/v1/audio/speech');
    expect(await request.json()).toEqual({ ...payload, model: 'native-speech' });
    return new Response(bytes, { headers: { 'content-type': 'audio/wav', 'x-provider-trace': 'speech-trace' } });
  }, async () => {
    const response = await post('/v1/audio/speech', payload);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/wav');
    expect(response.headers.get('x-provider-trace')).toBe('speech-trace');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });
  await flushAsyncWork();
  expect(await repo.usage.listAll()).toMatchObject([{ requests: 1, metrics: [] }]);
  expect(await repo.performance.listAll()).toMatchObject([{ operation: 'audio_speech', requests: 1 }]);
});

test('Speech follows the SSE stream_format on the short route and forwards its native error', async () => {
  const { repo, post } = await setupSpeechTest();
  const audio = { type: 'speech.audio.delta', audio: 'AA==' };
  const failure = { error: { type: 'server_error', message: 'speech failed' } };
  const body = `data: ${JSON.stringify(audio)}\n\ndata: ${JSON.stringify(failure)}\n\n`;
  await withMockedFetch(async request => {
    expect(await request.json()).toMatchObject({ stream_format: 'sse' });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }, async () => {
    const response = await post('/audio/speech', { model: 'speech', input: 'Hello', voice: 'alloy', stream_format: 'sse' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(await response.text()).toBe(body);
  });
  await flushAsyncWork();
  expect(await repo.usage.listAll()).toEqual([]);
  expect(await repo.performance.listAll()).toMatchObject([{ operation: 'audio_speech', requests: 1, errorsNoOutput: 1 }]);
});

test('Speech records the token quantities from the native SSE completion event', async () => {
  const { repo, post } = await setupSpeechTest();
  const audio = { type: 'speech.audio.delta', audio: 'AA==' };
  const done = { type: 'speech.audio.done', usage: { input_tokens: 4, output_tokens: 12, total_tokens: 16 } };
  const body = `data: ${JSON.stringify(audio)}\n\ndata: ${JSON.stringify(done)}\n\n`;
  await withMockedFetch(
    () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    async () => {
      const response = await post('/v1/audio/speech', { model: 'speech', input: 'Hello', voice: 'alloy', stream_format: 'sse' });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(body);
    },
  );
  await flushAsyncWork();
  expect(await repo.usage.listAll()).toMatchObject([{
    requests: 1,
    metrics: [
      { metric: 'input_tokens', quantity: '4' },
      { metric: 'output_tokens', quantity: '12' },
    ],
  }]);
});

test('Speech rejects a missing input before dialing', async () => {
  const { post } = await setupSpeechTest();
  await withMockedFetch(request => {
    throw new Error(`Unexpected upstream request ${request.url}`);
  }, async () => {
    const response = await post('/v1/audio/speech', { model: 'speech', voice: 'alloy' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining('input string') } });
  });
});
