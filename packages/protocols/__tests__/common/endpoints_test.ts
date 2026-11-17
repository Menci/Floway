import { test } from 'vitest';

import { kindForEndpoints, parseModelKind } from '../../src/common/endpoints.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('parseModelKind accepts endpoint families and rejects unknown storage values', () => {
  for (const kind of ['chat', 'embedding', 'image', 'rerank', 'transcription', 'decision'] as const) assertEquals(parseModelKind(kind), kind);
  assertThrows(() => parseModelKind('video'), Error, 'model kind is invalid: "video"');
  assertThrows(() => parseModelKind(null), Error, 'model kind is invalid: null');
});

test('kindForEndpoints returns embedding for OpenAI Embeddings and chat for chat-protocol endpoints', () => {
  assertEquals(kindForEndpoints({ openaiEmbeddings: {} }), 'embedding');
  assertEquals(kindForEndpoints({ openaiChatCompletions: {} }), 'chat');
  assertEquals(kindForEndpoints({ anthropicMessages: {} }), 'chat');
  assertEquals(kindForEndpoints({ openaiCompletions: {} }), 'chat');
});
