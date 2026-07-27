import { test } from 'vitest';

import { serializeModelPathAudioTranscriptionRequest, serializeOpenAIAudioTranscriptionRequest } from '../src/audio.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

test('serializeOpenAIAudioTranscriptionRequest preserves ordered fields and file metadata while replacing model', async () => {
  const file = new File([new Uint8Array([1, 2, 3, 4])], 'meeting.wav', {
    type: 'audio/wav',
    lastModified: 1_700_000_000_000,
  });
  const form = serializeOpenAIAudioTranscriptionRequest({
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

test('serializeModelPathAudioTranscriptionRequest omits model fields selected by the URL', () => {
  const form = serializeModelPathAudioTranscriptionRequest({
    entries: [
      { name: 'model', value: 'public-model' },
      { name: 'file', value: new File(['audio'], 'meeting.wav', { type: 'audio/wav' }) },
      { name: 'response_format', value: 'json' },
    ],
  });

  assertEquals([...form.keys()], ['file', 'response_format']);
  assertEquals(form.get('model'), null);
});
