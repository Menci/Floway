import { expect, test } from 'vitest';

import { forceStoreFalseForOpenAIResponses } from '../../../../src/data-plane/chat/openai-responses/force-store-false.ts';
import { compose, defineStage, move, run } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

test.each([false, true].flatMap(enabled => [undefined, false, true].map(store => ({ enabled, store }))))('store=false with enabled=$enabled and store=$store preserves immutable input identity', async ({ enabled, store }) => {
  const payload = move({ model: 'm', input: [], ...(store === undefined ? {} : { store }) } satisfies CanonicalOpenAIResponsesPayload);
  let seen: CanonicalOpenAIResponsesPayload | undefined;
  const ending = defineStage<Record<string, unknown>, Record<string, unknown>>({
    name: 'scriptedStatelessDial', return: { provides: ['response.chat.openaiResponses'] },
    execute: async facts => {
      seen = facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload;
      return move({ ...facts, 'response.chat.openaiResponses': { kind: 'value', body: {} } });
    },
  });
  const executed = await run(compose<Record<string, unknown>, Record<string, unknown>>('storeFalseUnderTest', [forceStoreFalseForOpenAIResponses, ending]), move({ 'request.chat.openaiResponses': payload, 'route.attempt': { candidateId: 0, upstreamId: 'up_test', modelId: 'm', flags: enabled ? ['openai-responses-store-false'] : [] } }), {});
  await executed.drain();
  expect(seen?.store).toBe(enabled ? false : store);
  expect(payload.store).toBe(store);
  expect(seen?.input).toBe(payload.input);
  if (!enabled || store === false) expect(seen).toBe(payload);
  else expect(seen).not.toBe(payload);
});
