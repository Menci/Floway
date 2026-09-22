import { test } from 'vitest';

import { kindForEndpoints, parseModelKind } from '../../src/common/endpoints.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('parseModelKind accepts endpoint families and rejects unknown storage values', () => {
  for (const kind of ['chat', 'embedding', 'image', 'rerank', 'transcription'] as const) assertEquals(parseModelKind(kind), kind);
  assertThrows(() => parseModelKind('video'), Error, 'model kind is invalid: "video"');
  assertThrows(() => parseModelKind(null), Error, 'model kind is invalid: null');
});

test('kindForEndpoints returns image when either images endpoint is present', () => {
  assertEquals(kindForEndpoints({ openaiImagesGenerations: {} }), 'image');
  assertEquals(kindForEndpoints({ openaiImagesEdits: {} }), 'image');
  assertEquals(kindForEndpoints({ openaiImagesGenerations: {}, openaiImagesEdits: {} }), 'image');
});

test('kindForEndpoints returns transcription for audio transcription', () => {
  assertEquals(kindForEndpoints({ openaiAudioTranscriptions: {} }), 'transcription');
});

test('kindForEndpoints returns embedding for OpenAI Embeddings and chat for chat-protocol endpoints', () => {
  assertEquals(kindForEndpoints({ openaiEmbeddings: {} }), 'embedding');
  assertEquals(kindForEndpoints({ openaiChatCompletions: {} }), 'chat');
  assertEquals(kindForEndpoints({ anthropicMessages: {} }), 'chat');
  assertEquals(kindForEndpoints({ openaiCompletions: {} }), 'chat');
});

test('kindForEndpoints returns rerank for the semantic rerank endpoint', () => {
  assertEquals(kindForEndpoints({ rerank: {} }), 'rerank');
});
