import { expect, test } from 'vitest';

import { decodeOpenAIAudioTranscriptionsResult, decodeOpenAIAudioTranscriptionsStream } from '../../src/openai-audio/index.ts';
import type { Result } from '@floway-dev/pipeline';

const encoder = new TextEncoder();
const chunks = async function* <Failure>(...items: (string | { error: Failure })[]): AsyncGenerator<Result<Uint8Array, Failure>> {
  for (const item of items) {
    yield typeof item === 'string'
      ? { ok: true, value: encoder.encode(item) }
      : { ok: false, error: item.error };
  }
};

test('retains the original SSE name when present and reads through the terminal event to native done', async () => {
  const delta = { type: 'transcript.text.delta', delta: 'hello' };
  const done = { type: 'transcript.text.done', text: 'hello' };
  const failure = { kind: 'transport', cause: new Error('socket reset after the terminal event') };
  const wire = [
    `event: vendor.transcript.delta\ndata: ${JSON.stringify(delta)}\n\n`,
    `data: ${JSON.stringify(done)}\n\n`,
  ];
  const events = [
    { ok: true, value: { data: delta, eventName: 'vendor.transcript.delta' } },
    { ok: true, value: { data: done } },
  ];
  expect(await Array.fromAsync(decodeOpenAIAudioTranscriptionsStream(chunks(...wire)))).toEqual(events);
  expect(await Array.fromAsync(decodeOpenAIAudioTranscriptionsStream(chunks(...wire, { error: failure })))).toEqual([
    ...events,
    { ok: false, error: failure },
  ]);
});

test.each(['vendor.transcription_error', undefined])('retains the terminating error wire name %s only when present', async eventName => {
  const event = { type: 'error', message: 'transcription unavailable' };
  const prefix = eventName === undefined ? '' : `event: ${eventName}\n`;
  const source = chunks(`${prefix}data: ${JSON.stringify(event)}\n\n`);

  expect(await Array.fromAsync(decodeOpenAIAudioTranscriptionsStream(source))).toStrictEqual([{
    ok: false,
    error: { kind: 'protocol', cause: expect.any(Error), event, ...(eventName === undefined ? {} : { eventName }) },
  }]);
});

test.each([
  ['application/json; charset=utf-8', ' { "text" : "hello", "example" : 1.00 }\n'],
  ['application/vnd.example+json', 'null'],
  ['text/plain', 'hello\n'],
  ['application/x-subrip', '1\n00:00:00,000 --> 00:00:01,000\nhello\n'],
  ['text/vtt', 'WEBVTT\n\nhello\n'],
  [null, 'untyped transcription'],
] as const)('preserves the original bytes for transcription format %s', (mediaType, input) => {
  const bytes = encoder.encode(input);
  const result = decodeOpenAIAudioTranscriptionsResult(bytes, mediaType);
  if (!result.ok) throw result.error;
  expect(result.value).toBe(bytes);
});

test.each(['', '{"text":', '<html>failure</html>'])('classifies invalid JSON transcription bytes %s as a parse error', input => {
  expect(decodeOpenAIAudioTranscriptionsResult(encoder.encode(input), 'application/json')).toEqual({ ok: false, error: expect.any(SyntaxError) });
});
