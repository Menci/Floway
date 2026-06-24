import { test } from 'vitest';

import { kindForEndpoints } from './capabilities.ts';
import { assertEquals } from '../test-assert.ts';

test('kindForEndpoints returns image when either images endpoint is present', () => {
  assertEquals(kindForEndpoints({ imagesGenerations: {} }), 'image');
  assertEquals(kindForEndpoints({ imagesEdits: {} }), 'image');
  assertEquals(kindForEndpoints({ imagesGenerations: {}, imagesEdits: {} }), 'image');
});

test('kindForEndpoints returns embedding for embeddings and chat for chat-protocol endpoints', () => {
  assertEquals(kindForEndpoints({ embeddings: {} }), 'embedding');
  assertEquals(kindForEndpoints({ chatCompletions: {} }), 'chat');
  assertEquals(kindForEndpoints({ messages: {} }), 'chat');
  assertEquals(kindForEndpoints({ completions: {} }), 'chat');
});
