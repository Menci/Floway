import { test } from 'vitest';

import { kindForEndpoints, parseModelKind } from '../../src/common/endpoints.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('parseModelKind accepts endpoint families and rejects unknown storage values', () => {
  for (const kind of ['chat', 'embedding', 'image', 'rerank', 'transcription'] as const) assertEquals(parseModelKind(kind), kind);
  assertThrows(() => parseModelKind('video'), Error, 'model kind is invalid: "video"');
  assertThrows(() => parseModelKind(null), Error, 'model kind is invalid: null');
});

test('kindForEndpoints returns image when either images endpoint is present', () => {
  assertEquals(kindForEndpoints({ imagesGenerations: {} }), 'image');
  assertEquals(kindForEndpoints({ imagesEdits: {} }), 'image');
  assertEquals(kindForEndpoints({ imagesGenerations: {}, imagesEdits: {} }), 'image');
});

test('kindForEndpoints returns transcription for audio transcription', () => {
  assertEquals(kindForEndpoints({ audioTranscriptions: {} }), 'transcription');
});

test('kindForEndpoints returns embedding for embeddings and chat for chat-protocol endpoints', () => {
  assertEquals(kindForEndpoints({ embeddings: {} }), 'embedding');
  assertEquals(kindForEndpoints({ chatCompletions: {} }), 'chat');
  assertEquals(kindForEndpoints({ messages: {} }), 'chat');
  assertEquals(kindForEndpoints({ completions: {} }), 'chat');
});

test('kindForEndpoints returns rerank for the semantic rerank endpoint', () => {
  assertEquals(kindForEndpoints({ rerank: {} }), 'rerank');
});
