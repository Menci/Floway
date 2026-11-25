import { test } from 'vitest';

import { serializeModelPathOpenAIAudioTranscriptionRequest, serializeModelFieldOpenAIAudioTranscriptionRequest } from '../src/audio.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

test('serializeModelFieldOpenAIAudioTranscriptionRequest preserves ordered fields and file metadata while replacing model', async () => {
  const file = { name: 'meeting.wav', type: 'audio/wav', bytes: Uint8Array.of(1, 2, 3, 4) };
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
  assertEquals(new Uint8Array(await (serializedFile as File).arrayBuffer()), file.bytes);
});

test('serializeModelPathOpenAIAudioTranscriptionRequest omits model fields selected by the URL', () => {
  const form = serializeModelPathOpenAIAudioTranscriptionRequest({
    entries: [
      { name: 'model', value: 'public-model' },
      { name: 'file', value: { name: 'meeting.wav', type: 'audio/wav', bytes: new TextEncoder().encode('audio') } },
      { name: 'response_format', value: 'json' },
    ],
  });

  assertEquals([...form.keys()], ['file', 'response_format']);
  assertEquals(form.get('model'), null);
});
