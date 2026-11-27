import { test } from 'vitest';

import { inferEndpointsFromModelId } from '../src/infer-endpoints.ts';
import { assertEquals } from '@floway-dev/test-utils';

const OPENAI_EMBEDDINGS = { openaiEmbeddings: {} };
const OPENAI_AUDIO = { openaiAudioTranscriptions: {} };

test('inferEndpointsFromModelId returns OpenAI Embeddings for embedding family tokens', () => {
  assertEquals(inferEndpointsFromModelId('BAAI/bge-large-en'), OPENAI_EMBEDDINGS);
});

test('inferEndpointsFromModelId returns audio transcription for standard transcribe and whisper families', () => {
  for (const id of ['gpt-4o-mini-transcribe-2025-12-15', 'openai/whisper-large-v3']) {
    assertEquals(inferEndpointsFromModelId(id), OPENAI_AUDIO);
  }
});
