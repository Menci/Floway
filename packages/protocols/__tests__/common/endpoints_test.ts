import { test } from 'vitest';

import { PUBLIC_DATA_PLANE_ROUTES } from '../../src/common/data-plane-routes.ts';
import { kindForEndpoints, parseModelKind } from '../../src/common/endpoints.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('kindForEndpoints returns embedding for OpenAI Embeddings and chat for chat-protocol endpoints', () => {
  assertEquals(kindForEndpoints({ openaiEmbeddings: {} }), 'embedding');
  assertEquals(kindForEndpoints({ openaiChatCompletions: {} }), 'chat');
  assertEquals(kindForEndpoints({ anthropicMessages: {} }), 'chat');
  assertEquals(kindForEndpoints({ openaiCompletions: {} }), 'chat');
});

test('speech has a model kind and the OpenAI Audio Speech route aliases', () => {
  assertEquals(parseModelKind('speech'), 'speech');
  assertEquals(kindForEndpoints({ openaiAudioSpeech: {}, decision: {} }), 'speech');
  assertEquals(kindForEndpoints({ openaiAudioSpeech: {}, openaiAudioTranscriptions: {} }), 'transcription');
  assertEquals(PUBLIC_DATA_PLANE_ROUTES.openaiAudioSpeech, { method: 'POST', paths: ['/v1/audio/speech', '/audio/speech'] });
});
