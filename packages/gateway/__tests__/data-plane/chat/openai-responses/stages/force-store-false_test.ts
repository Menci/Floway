import { test } from 'vitest';

import { forceStoreFalse } from '../../../../../src/data-plane/chat/openai-responses/stages/force-store-false.ts';
import { createManagedProtocolFrames, runChatStage, stubRouteCandidate } from '../../../../test-utils/chat-pipeline.ts';
import { assertEquals, testTelemetryModelIdentity } from '@floway-dev/test-utils';

test('forces store false when the provider flag is enabled', async () => {
  let payload: import('@floway-dev/protocols/openai-responses').CanonicalOpenAIResponsesPayload | undefined;
  await runChatStage({
    stage: forceStoreFalse,
    facts: { 'route.candidate': stubRouteCandidate({ enabledFlags: ['openai-responses-store-false'] }), 'request.payload': { model: 'm', input: [], store: true }, 'request.action': 'generate', 'route.targetApi': 'openaiResponses' },
    next: (provided, env) => {
      payload = provided['request.payload'];
      return { type: 'events' as const, events: createManagedProtocolFrames(env, []), modelIdentity: testTelemetryModelIdentity };
    },
  });
  assertEquals(payload?.store, false);
});
