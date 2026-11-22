import { test } from 'vitest';

import { disableReasoningOnForcedToolChoice } from '../../../../../src/data-plane/chat/openai-responses/stages/disable-reasoning-on-forced-tool-choice.ts';
import { createManagedProtocolFrames, runChatStage, stubRouteCandidate } from '../../../../test-utils/chat-pipeline.ts';
import { testTelemetryModelIdentity, assertEquals } from '@floway-dev/test-utils';

const run = async (toolChoice: unknown, enabled: boolean) => {
  let payload: unknown;
  const facts = {
    'route.candidate': stubRouteCandidate({ enabledFlags: enabled ? ['disable-reasoning-on-forced-tool-choice'] : [] }),
    'request.payload': { model: 'm', input: [], tool_choice: toolChoice } as never,
    'request.action': 'generate' as const,
    'route.targetApi': 'openaiResponses' as const,
  };
  await runChatStage({
    stage: disableReasoningOnForcedToolChoice,
    facts,
    next: (provided, env) => {
      payload = provided['request.payload'];
      return { type: 'events' as const, events: createManagedProtocolFrames(env, []), modelIdentity: testTelemetryModelIdentity };
    },
  });
  return payload as { reasoning?: unknown };
};

test('sets the canonical reasoning sentinel for a forced tool choice', async () => {
  assertEquals((await run('required', true)).reasoning, { effort: 'none' });
});
test('leaves autonomous choice and a disabled flag untouched', async () => {
  assertEquals((await run('auto', true)).reasoning, undefined);
  assertEquals((await run('required', false)).reasoning, undefined);
});
