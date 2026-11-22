import { test } from 'vitest';

import { applyRoleCompatibility } from '../../../../../src/data-plane/chat/openai-responses/stages/apply-role-compatibility.ts';
import { createManagedProtocolFrames, runChatStage, stubRouteCandidate } from '../../../../test-utils/chat-pipeline.ts';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';
import { assertEquals, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const apply = async (input: CanonicalOpenAIResponsesInputItem[], flags: import('@floway-dev/provider').FlagId[], targetApi: 'openaiResponses' | 'openaiChatCompletions' = 'openaiResponses') => {
  let seen: CanonicalOpenAIResponsesInputItem[] | undefined;
  await runChatStage({
    stage: applyRoleCompatibility,
    facts: { 'route.candidate': stubRouteCandidate({ enabledFlags: flags }), 'request.payload': { model: 'm', input }, 'request.action': 'generate', 'route.targetApi': targetApi },
    next: (provided, env) => {
      seen = provided['request.payload'].input;
      return { type: 'events' as const, events: createManagedProtocolFrames(env, []), modelIdentity: testTelemetryModelIdentity };
    },
  });
  return seen;
};

test('rewrites later system messages after the leading system run', async () => {
  assertEquals(await apply([
    { type: 'message', role: 'system', content: 'base' },
    { type: 'reasoning', id: 'rs', summary: [] },
    { type: 'message', role: 'system', content: 'inline' },
  ], ['rewrite-mid-conv-system-to-user']), [
    { type: 'message', role: 'system', content: 'base' },
    { type: 'reasoning', id: 'rs', summary: [] },
    { type: 'message', role: 'user', content: 'inline' },
  ]);
});
test('does not apply native role flags to translated targets', async () => {
  const input: CanonicalOpenAIResponsesInputItem[] = [{ type: 'message', role: 'system', content: 'keep' }];
  assertEquals(await apply(input, ['rewrite-system-to-developer'], 'openaiChatCompletions'), input);
});
