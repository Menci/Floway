import { test } from 'vitest';

import { kindForEndpoints } from '../../src/common/endpoints.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('kindForEndpoints returns embedding for OpenAI Embeddings and chat for chat-protocol endpoints', () => {
  assertEquals(kindForEndpoints({ openaiEmbeddings: {} }), 'embedding');
  assertEquals(kindForEndpoints({ openaiChatCompletions: {} }), 'chat');
  assertEquals(kindForEndpoints({ anthropicMessages: {} }), 'chat');
  assertEquals(kindForEndpoints({ openaiCompletions: {} }), 'chat');
});
