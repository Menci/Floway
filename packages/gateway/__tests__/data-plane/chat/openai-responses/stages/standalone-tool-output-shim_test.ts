import { test } from 'vitest';

import { standaloneToolOutputShim } from '../../../../../src/data-plane/chat/openai-responses/stages/standalone-tool-output-shim.ts';
import { createManagedProtocolFrames, runChatStage, stubRouteCandidate } from '../../../../test-utils/chat-pipeline.ts';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';
import { decodeResponseBody, type FlagId } from '@floway-dev/provider';
import { assert, assertEquals, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const flag = new Set<FlagId>(['openai-responses-standalone-tool-output-shim']);
const lower = async (input: CanonicalOpenAIResponsesInputItem[], enabledFlags: ReadonlySet<FlagId> = new Set()) => {
  const candidate = stubRouteCandidate({ enabledFlags });
  let seen: CanonicalOpenAIResponsesInputItem[] | undefined;
  const { outcome } = await runChatStage({
    stage: standaloneToolOutputShim,
    facts: { 'route.candidate': candidate, 'request.payload': { model: 'm', input }, 'request.action': 'generate', 'route.targetApi': 'openaiResponses' },
    next: (provided, env) => {
      seen = provided['request.payload'].input;
      return { type: 'events' as const, events: createManagedProtocolFrames(env, []), modelIdentity: testTelemetryModelIdentity };
    },
  });
  return { outcome, seen };
};

const standalone: CanonicalOpenAIResponsesInputItem = { type: 'function_call_output', name: 'goal_objective', output: 'objective' };
test('lowers standalone output when enabled', async () => {
  const { seen } = await lower([standalone], flag);
  assert(seen !== undefined);
  assertEquals(seen[0]?.type, 'message');
});
test('forwards standalone output verbatim without the flag', async () => {
  const { seen } = await lower([standalone]);
  assertEquals(seen, [standalone]);
});
test('reports an exact 400 when the standalone output has no name', async () => {
  const { outcome, seen } = await lower([{ type: 'function_call_output', output: 'orphan' }], flag);
  assertEquals(seen, undefined);
  assert(outcome.type === 'api-error');
  assertEquals(outcome.http.status, 400);
  assertEquals((JSON.parse(decodeResponseBody(outcome.body)) as { error: { param: string } }).error.param, 'input[0].name');
});
