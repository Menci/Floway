import { test } from 'vitest';

import { serializeModelPathOpenAIAudioTranscriptionRequest, serializeModelFieldOpenAIAudioTranscriptionRequest, serializeOpenAIAudioTranscriptionsBody } from '../src/audio.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

test('serializeModelFieldOpenAIAudioTranscriptionRequest preserves ordered fields and file metadata while replacing model', async () => {
  const file = new File([new Uint8Array([1, 2, 3, 4])], 'meeting.wav', {
    type: 'audio/wav',
    lastModified: 1_700_000_000_000,
  });
  const form = serializeModelFieldOpenAIAudioTranscriptionRequest({
    entries: [
      { name: 'file', value: file },
      { name: 'language', value: 'en' },
      { name: 'model', value: 'public-model' },
      { name: 'timestamp_granularities[]', value: 'word' },
      { name: 'timestamp_granularities[]', value: 'segment' },
    ],
  }, 'upstream-model');

  assertEquals([...form.keys()], ['file', 'language', 'model', 'timestamp_granularities[]', 'timestamp_granularities[]']);
  assertEquals(form.get('model'), 'upstream-model');
  assertEquals(form.getAll('timestamp_granularities[]'), ['word', 'segment']);
  const serializedFile = form.get('file');
  assertEquals(serializedFile instanceof File, true);
  assertExists(serializedFile as File);
  assertEquals((serializedFile as File).name, 'meeting.wav');
  assertEquals((serializedFile as File).type, 'audio/wav');
  assertEquals((serializedFile as File).lastModified, file.lastModified);
  assertEquals(new Uint8Array(await (serializedFile as File).arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
});

test('serializeModelPathOpenAIAudioTranscriptionRequest omits model fields selected by the URL', () => {
  const form = serializeModelPathOpenAIAudioTranscriptionRequest({
    entries: [
      { name: 'model', value: 'public-model' },
      { name: 'file', value: new File(['audio'], 'meeting.wav', { type: 'audio/wav' }) },
      { name: 'response_format', value: 'json' },
    ],
  });

  assertEquals([...form.keys()], ['file', 'response_format']);
  assertEquals(form.get('model'), null);
});

test('serializeOpenAIAudioTranscriptionsBody preserves repeated fields and audio bytes from facts', async () => {
  const { body, contentType } = await serializeOpenAIAudioTranscriptionsBody({
    entries: [
      { name: 'model', value: 'public-model' },
      { name: 'file', value: { name: 'turn.wav', mediaType: 'audio/wav', bytes: new Uint8Array([0, 3, 5]) } },
      { name: 'timestamp_granularities[]', value: 'word' },
      { name: 'timestamp_granularities[]', value: 'segment' },
    ],
  }, { type: 'replace', value: 'upstream-model' });
  const form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
  assertEquals([...form.keys()], ['model', 'file', 'timestamp_granularities[]', 'timestamp_granularities[]']);
  assertEquals(form.get('model'), 'upstream-model');
  assertEquals(form.getAll('timestamp_granularities[]'), ['word', 'segment']);
  const file = form.get('file');
  if (!(file instanceof File)) throw new Error('Expected the transcription audio file');
  assertEquals(file.name, 'turn.wav');
  assertEquals(file.type, 'audio/wav');
  assertEquals(new Uint8Array(await file.arrayBuffer()), new Uint8Array([0, 3, 5]));
});
