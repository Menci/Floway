import { expect, test } from 'vitest';

import { bodyBytes, bodyStream, mediaCandidate, mediaHost, mediaRequest, multipartBody, upload } from './media-fixture.ts';
import { openaiAudioSpeechIngress, openaiAudioTranscriptionsIngress } from '../../../../src/data-plane/non-chat/openai-audio/index.ts';
import { getHeader } from '@floway-dev/http';
import { run } from '@floway-dev/pipeline';

test('audio speech sends typed input and delivers upstream audio bytes', async () => {
  const bytes = Uint8Array.of(0, 127, 255);
  const host = mediaHost([mediaCandidate('audio', 'speech', { openaiAudioSpeech: {} })], id => async (url, init) => {
    expect(id).toBe('audio');
    expect(new URL(url).pathname).toBe('/v1/audio/speech');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer wire-key');
    if (typeof init.body !== 'string') throw new TypeError('Expected an audio speech JSON body');
    expect(JSON.parse(init.body)).toEqual({
      model: 'wire-model',
      input: 'Hello',
      voice: { id: 'voice-1', extension: true },
      response_format: 'operator-format',
    });
    return new Response(bytes, { status: 201, headers: { 'content-type': 'audio/mpeg', 'x-provider-trace': 'trace' } });
  });

  const request = await mediaRequest('/audio/speech', {
    model: 'public-model',
    input: 'Hello',
    voice: { id: 'voice-1', extension: true },
    response_format: 'operator-format',
  });
  const execution = run(openaiAudioSpeechIngress, request, host.options);
  const answer = await execution.result;
  expect(answer.http?.status).toBe(201);
  expect(getHeader(answer.http!.headers, 'content-type')).toBe('audio/mpeg');
  expect(getHeader(answer.http!.headers, 'x-provider-trace')).toBe('trace');
  expect(bodyBytes(answer.http)).toEqual(bytes);
  expect(answer.candidate).toEqual({ upstreamId: 'audio', model: 'public-model' });
  await expect(execution.read(answer.usage!)).resolves.toMatchObject({ kind: 'observed', usage: [{ reported: false, quantities: {} }] });
  host.controller.abort();
  execution.discard(answer);
  await host.settle();
  expect(host.recordPerformance).toHaveBeenCalledWith(expect.objectContaining({ operation: 'audio_speech', failed: false }));
  expect(host.recordUsage).toHaveBeenCalledOnce();
  expect(host.errors).toEqual([]);
});

test('audio transcription retains multipart bytes and closes an open upstream after its named terminal', async () => {
  const audio = Uint8Array.of(5, 0, 249);
  const form = new FormData();
  form.append('file', new File([audio], 'sample.wav', { type: 'audio/wav' }));
  form.append('timestamp_granularities[]', 'word');
  form.append('model', 'public-model');
  form.append('timestamp_granularities[]', 'segment');
  form.append('stream', 'true');
  const terminal = 'event: transcript.text.done\ndata: {"type":"transcript.text.done","text":"hello","usage":{"type":"duration","seconds":0.5}}\n\n';
  let upstreamCancellations = 0;
  const host = mediaHost([mediaCandidate('audio', 'transcription', { openaiAudioTranscriptions: {} })], () => async (_url, init) => {
    const dispatched = await multipartBody(init);
    expect([...dispatched.keys()]).toEqual([...form.keys()]);
    expect(dispatched.get('model')).toBe('wire-model');
    expect(dispatched.getAll('timestamp_granularities[]')).toEqual(['word', 'segment']);
    const file = upload(dispatched.get('file'));
    expect({ name: file.name, type: file.type }).toEqual({ name: 'sample.wav', type: 'audio/wav' });
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(audio);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(terminal));
      },
      cancel() {
        upstreamCancellations++;
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
  const execution = run(openaiAudioTranscriptionsIngress, await mediaRequest('/audio/transcriptions', form), host.options);
  const answer = await execution.result;
  const reader = execution.read(bodyStream(answer.http));
  await expect(reader.next()).resolves.toEqual({ done: false, value: { ok: true, value: new TextEncoder().encode(terminal) } });
  await expect(reader.next()).resolves.toMatchObject({ done: true });
  expect(upstreamCancellations).toBe(1);
  await expect(execution.read(answer.usage!)).resolves.toMatchObject({ kind: 'observed', usage: [{ quantities: { input_audio_seconds: '0.5' } }] });
  host.controller.abort();
  execution.discard(answer);
  await host.settle();
  expect(host.recordPerformance).toHaveBeenCalledWith(expect.objectContaining({ operation: 'audio_transcription', failed: false }));
  expect(host.recordUsage).toHaveBeenCalledOnce();
  expect(host.errors).toEqual([]);
});

test.each([
  {
    label: 'duration usage before the verbose JSON duration',
    result: { usage: { type: 'duration', seconds: 91 }, duration: 91.8 },
    quantities: { input_audio_seconds: '91' },
  },
  {
    label: 'Whisper verbose JSON duration',
    result: { task: 'transcribe', duration: 91.8 },
    quantities: { input_audio_seconds: '91.8' },
  },
  {
    label: 'input tokens with only a text breakdown',
    result: { usage: { type: 'tokens', input_tokens: 14, input_token_details: { text_tokens: 4 }, output_tokens: 45, total_tokens: 59 } },
    quantities: { input_tokens: '14', output_tokens: '45' },
  },
  {
    label: 'input tokens with only an audio breakdown',
    result: { usage: { type: 'tokens', input_tokens: 14, input_token_details: { audio_tokens: 10 }, output_tokens: 45, total_tokens: 59 } },
    quantities: { input_tokens: '4', input_audio_tokens: '10', output_tokens: '45' },
  },
  { label: 'invalid duration', result: { duration: '10' }, quantities: {} },
  {
    label: 'inconsistent token totals',
    result: { usage: { type: 'tokens', input_tokens: 14, output_tokens: 45, total_tokens: 58 } },
    quantities: {},
  },
  {
    label: 'oversized input detail counts',
    result: { usage: { type: 'tokens', input_tokens: 14, input_token_details: { text_tokens: 6, audio_tokens: 9 }, output_tokens: 45, total_tokens: 59 } },
    quantities: {},
  },
])('audio transcription accounts for $label', async ({ result, quantities }) => {
  const body = { text: 'hello', ...result };
  const host = mediaHost([mediaCandidate('audio', 'transcription', { openaiAudioTranscriptions: {} })], () => async () =>
    new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }));
  const form = new FormData();
  form.append('file', new File([Uint8Array.of(1)], 'sample.wav', { type: 'audio/wav' }));
  form.append('model', 'public-model');
  const execution = run(openaiAudioTranscriptionsIngress, await mediaRequest('/audio/transcriptions', form), host.options);
  const answer = await execution.result;
  const reported = Object.keys(quantities).length > 0;
  expect(answer.http?.status).toBe(200);
  expect(JSON.parse(new TextDecoder().decode(bodyBytes(answer.http)))).toEqual(body);
  await expect(execution.read(answer.usage!)).resolves.toMatchObject({ kind: 'observed', usage: [{ quantities, reported }] });
  host.controller.abort();
  execution.discard(answer);
  await host.settle();
  expect(host.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ modelKey: 'wire-model' }), expect.objectContaining({ quantities, reported }));
  expect(host.errors).toEqual([]);
});
