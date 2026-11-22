import { test } from 'vitest';

import { normalizeExclusiveCachedTokens } from '../../../../../src/data-plane/chat/openai-responses/stages/normalize-exclusive-cached-tokens.ts';
import { createManagedProtocolFrames, runChatStage, stubRouteCandidate } from '../../../../test-utils/chat-pipeline.ts';
import type { OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { assert, assertEquals, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const response = (usage: NonNullable<OpenAIResponsesResultEx['usage']>): OpenAIResponsesStreamEventEx => ({
  type: 'response.completed', sequence_number: 0,
  response: { id: 'r', object: 'response', model: 'm', status: 'completed', output: [], error: null, incomplete_details: null, usage },
});

const run = async (usage: NonNullable<OpenAIResponsesResultEx['usage']>, flags: import('@floway-dev/provider').FlagId[]) => {
  let usageId: string | undefined;
  const { outcome } = await runChatStage({
    stage: normalizeExclusiveCachedTokens,
    facts: { 'route.candidate': stubRouteCandidate({ enabledFlags: flags }), 'request.payload': { model: 'm', input: [] }, 'request.action': 'generate', 'route.targetApi': 'openaiResponses' },
    next: (_provided, env) => {
      usageId = env.usageLedger.register({ modelIdentity: testTelemetryModelIdentity });
      return { type: 'events' as const, events: createManagedProtocolFrames(env, [response(usage)]), modelIdentity: testTelemetryModelIdentity, usageId };
    },
  });
  assert(outcome.type === 'events');
  const frames = []; for await (const frame of outcome.events) frames.push(frame);
  const first = frames[0]; if (first?.type !== 'event' || !('response' in first.event)) throw new Error('missing response');
  return first.event.response.usage;
};

test('folds cache reads and writes into inclusive input tokens', async () => {
  assertEquals((await run({ input_tokens: 100, output_tokens: 10, total_tokens: 390, input_tokens_details: { cached_tokens: 120, cache_write_tokens: 80 } } as never, ['usage-exclusive-cached-tokens']))?.input_tokens, 300);
});
test('leaves translated responses untouched', async () => {
  const usage = { input_tokens: 479, output_tokens: 373, total_tokens: 14164, input_tokens_details: { cached_tokens: 13312 } };
  const result = await runChatStage({
    stage: normalizeExclusiveCachedTokens,
    facts: { 'route.candidate': stubRouteCandidate({ enabledFlags: ['usage-exclusive-cached-tokens'] }), 'request.payload': { model: 'm', input: [] }, 'request.action': 'generate', 'route.targetApi': 'openaiChatCompletions' },
    next: (provided, env) => ({ type: 'events' as const, events: createManagedProtocolFrames(env, [response(usage)]), modelIdentity: testTelemetryModelIdentity }),
  });
  assert(result.outcome.type === 'events');
});
