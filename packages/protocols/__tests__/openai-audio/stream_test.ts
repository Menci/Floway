import { expect, test } from 'vitest';

import { parseOpenAIAudioTranscriptionStream } from '../../src/openai-audio/stream.ts';
import { sseFrame, sseFrameBody } from '../common/test-utils.ts';

test('preserves the named transcription event and completes after transcript.text.done', async () => {
  const event = { type: 'transcript.text.done', text: 'hi' };
  const frame = sseFrame(JSON.stringify(event), 'transcript.text.done');
  const body = sseFrameBody(frame, sseFrame('not JSON'));

  expect(await Array.fromAsync(parseOpenAIAudioTranscriptionStream(body))).toEqual([
    { type: 'event', event, frame }, { type: 'done' },
  ]);
});

test('preserves an upstream transcription error event and its wire frame', async () => {
  const error = { error: { type: 'server_error', message: 'unavailable' } };
  const frame = sseFrame(JSON.stringify(error), 'error');

  expect(await Array.fromAsync(parseOpenAIAudioTranscriptionStream(sseFrameBody(frame)))).toMatchObject([
    { type: 'error', cause: { message: 'unavailable', cause: error }, frame },
  ]);
});

test('reports a raw done sentinel before the required transcription event as a protocol error', async () => {
  expect(await Array.fromAsync(parseOpenAIAudioTranscriptionStream(sseFrameBody(sseFrame('[DONE]'))))).toMatchObject([
    { type: 'error', cause: { message: 'OpenAI Transcriptions stream ended without a transcript.text.done event.', cause: '[DONE]' } },
  ]);
});
