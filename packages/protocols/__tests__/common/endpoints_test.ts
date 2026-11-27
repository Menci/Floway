import { test } from 'vitest';

import { PUBLIC_DATA_PLANE_ROUTES } from '../../src/common/data-plane-routes.ts';
import { kindForEndpoints } from '../../src/common/endpoints.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('kindForEndpoints returns embedding for OpenAI Embeddings and chat for chat-protocol endpoints', () => {
  assertEquals(kindForEndpoints({ openaiEmbeddings: {} }), 'embedding');
  assertEquals(kindForEndpoints({ openaiChatCompletions: {} }), 'chat');
  assertEquals(kindForEndpoints({ anthropicMessages: {} }), 'chat');
  assertEquals(kindForEndpoints({ openaiCompletions: {} }), 'chat');
});

test('OpenAI Audio Speech has a dedicated model kind and public routes', () => {
  assertEquals(kindForEndpoints({ openaiAudioSpeech: {} }), 'speech');
  assertEquals(PUBLIC_DATA_PLANE_ROUTES.openaiAudioSpeech, {
    method: 'POST',
    paths: ['/v1/audio/speech', '/audio/speech'],
  });
});
