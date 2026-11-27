import { expect, test } from 'vitest';

import { decodeOpenAIAudioSpeechStream, decodeOpenAIAudioTranscriptionsStream } from '../../src/openai-audio/index.ts';
import { sseByteStream, sseFrame } from '../common/test-utils.ts';

test('OpenAI Audio Transcriptions preserves wire event names and recognizes transcript completion', async () => {
  const delta = { type: 'transcript.text.delta', delta: 'hello' };
  const done = { type: 'transcript.text.done', text: 'hello', usage: { type: 'duration', seconds: 1 } };
  const body = sseByteStream(sseFrame(JSON.stringify(delta)), sseFrame(JSON.stringify(done), 'transcript.text.done'));
  expect(await Array.fromAsync(decodeOpenAIAudioTranscriptionsStream(body))).toEqual([
    { ok: true, value: { data: delta } },
    { ok: true, value: { data: done, eventName: 'transcript.text.done' } },
  ]);
});

test('OpenAI Audio Transcriptions requires a complete transcript', async () => {
  const body = sseByteStream(sseFrame('{"type":"transcript.text.delta","delta":"hello"}'), sseFrame('[DONE]'));
  const decoded = await Array.fromAsync(decodeOpenAIAudioTranscriptionsStream(body));
  expect(decoded.at(-1)).toMatchObject({
    ok: false,
    error: { kind: 'protocol', cause: { message: expect.stringContaining('transcript.text.done') } },
  });
});

test('OpenAI Audio Speech decodes SSE audio chunks', async () => {
  const delta = { type: 'speech.audio.delta', audio: 'AQID' };
  const body = sseByteStream(sseFrame(JSON.stringify(delta)));
  expect(await Array.fromAsync(decodeOpenAIAudioSpeechStream(body))).toEqual([{ ok: true, value: delta }]);
});

test('OpenAI Audio Speech rejects a present non-string type', async () => {
  const event = { type: 42, audio: 'AQID' };
  const body = sseByteStream(sseFrame(JSON.stringify(event), 'speech.audio.delta'));
  expect(await Array.fromAsync(decodeOpenAIAudioSpeechStream(body))).toMatchObject([
    { ok: false, error: { kind: 'protocol', event, eventName: 'speech.audio.delta', cause: { cause: 42 } } },
  ]);
});

test('OpenAI Audio Speech accepts unnamed events and preserves open event names', async () => {
  const named = { audio: 'AQID', vendor: true };
  const unnamed = { vendor: true };
  const typed = { type: 'future.speech.event', vendor: true };
  const body = sseByteStream(sseFrame(JSON.stringify(named), 'speech.audio.delta'), sseFrame(JSON.stringify(unnamed)), sseFrame(JSON.stringify(typed)));
  expect(await Array.fromAsync(decodeOpenAIAudioSpeechStream(body))).toEqual([
    { ok: true, value: { ...named, type: 'speech.audio.delta' } },
    { ok: true, value: unnamed },
    { ok: true, value: typed },
  ]);
});
