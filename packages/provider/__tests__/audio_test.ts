import { expect, test } from 'vitest';

import { serializeModelFieldOpenAIAudioTranscriptionRequest, serializeModelPathOpenAIAudioTranscriptionRequest } from '../src/audio.ts';
import type { MultipartField } from '../src/request-body.ts';
import { Bytes } from '@floway-dev/pipeline';

const file = { kind: 'file', name: 'file', bytes: Bytes.fromUtf8('audio'), filename: 'meeting.wav', contentType: 'audio/wav' } as const;
const entries = [
  file,
  { kind: 'text', name: 'language', value: 'en' },
  { kind: 'text', name: 'model', value: 'public-model' },
  { kind: 'text', name: 'timestamp_granularities[]', value: 'word' },
  { kind: 'text', name: 'timestamp_granularities[]', value: 'segment' },
] as const satisfies readonly MultipartField[];

test('preserves ordered audio fields and file metadata while replacing the model field', () => {
  const form = serializeModelFieldOpenAIAudioTranscriptionRequest({ entries }, 'upstream-model');
  expect(form.parts).toEqual([...entries.slice(0, 2), { kind: 'text', name: 'model', value: 'upstream-model' }, ...entries.slice(3)]);
  expect(form.parts[0]).toBe(file);
});

test('omits model fields selected by the URL', () => {
  expect(serializeModelPathOpenAIAudioTranscriptionRequest({ entries }).parts).toEqual(entries.filter(entry => entry.name !== 'model'));
});
