import { test } from 'vitest';

import { stripPromptCacheKey } from '../../../../../src/data-plane/chat/openai-responses/stages/strip-prompt-cache-key.ts';
import { createManagedProtocolFrames, runChatStage, stubRouteCandidate } from '../../../../test-utils/chat-pipeline.ts';
import { assertEquals, testTelemetryModelIdentity } from '@floway-dev/test-utils';

test('drops prompt_cache_key only under the provider flag', async () => {
  const run = async (enabled: boolean) => {
    let payload: Record<string, unknown> | undefined;
    await runChatStage({
      stage: stripPromptCacheKey,
      facts: { 'route.candidate': stubRouteCandidate({ enabledFlags: enabled ? ['strip-prompt-cache-key'] : [] }), 'request.payload': { model: 'm', input: [], prompt_cache_key: 'cache' }, 'request.action': 'generate', 'route.targetApi': 'openaiResponses' },
      next: (provided, env) => {
        payload = provided['request.payload'] as unknown as Record<string, unknown>;
        return { type: 'events' as const, events: createManagedProtocolFrames(env, []), modelIdentity: testTelemetryModelIdentity };
      },
    });
    return payload;
  };
  assertEquals((await run(true))?.prompt_cache_key, undefined);
  assertEquals((await run(false))?.prompt_cache_key, 'cache');
});
