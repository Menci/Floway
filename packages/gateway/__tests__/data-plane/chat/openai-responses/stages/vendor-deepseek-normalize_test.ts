import { test } from 'vitest';

import { vendorDeepSeekNormalize } from '../../../../../src/data-plane/chat/openai-responses/stages/vendor-deepseek-normalize.ts';
import { createManagedProtocolFrames, runChatStage, stubRouteCandidate } from '../../../../test-utils/chat-pipeline.ts';
import { assertEquals, testTelemetryModelIdentity } from '@floway-dev/test-utils';

test('translates the canonical no-reasoning sentinel for DeepSeek', async () => {
  let payload: Record<string, unknown> | undefined;
  await runChatStage({
    stage: vendorDeepSeekNormalize,
    facts: { 'route.candidate': stubRouteCandidate({ enabledFlags: ['vendor-deepseek'] }), 'request.payload': { model: 'm', input: [], reasoning: { effort: 'none' } }, 'request.action': 'generate', 'route.targetApi': 'openaiResponses' },
    next: (provided, env) => {
      payload = provided['request.payload'] as unknown as Record<string, unknown>;
      return { type: 'events' as const, events: createManagedProtocolFrames(env, []), modelIdentity: testTelemetryModelIdentity };
    },
  });
  assertEquals(payload?.reasoning, undefined);
  assertEquals(payload?.thinking, { type: 'disabled' });
});
