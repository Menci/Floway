import { test } from 'vitest';

import { withPromptCacheKeyStripped } from '../../../../../src/data-plane/chat/openai-responses/interceptors/strip-prompt-cache-key.ts';
import type { OpenAIResponsesInvocation } from '../../../../../src/data-plane/chat/openai-responses/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import { eventResult, type FlagId } from '@floway-dev/upstream';

const stubCtx = mockChatGatewayCtx();

const okEvents = () =>
  Promise.resolve(
    eventResult(
      (async function* () {
        yield doneFrame();
      })(),
      testTelemetryModelIdentity,
    ),
  );

const invocation = (
  payload: CanonicalOpenAIResponsesPayload,
  enabledFlags: ReadonlySet<FlagId> = new Set(['strip-prompt-cache-key']),
): OpenAIResponsesInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'openaiResponses',
  headers: new Headers(),
  action: 'generate',
});

test('drops top-level prompt_cache_key when the flag is on', async () => {
  const input = invocation({
    model: 'm',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    prompt_cache_key: 'thread-42',
  });

  await withPromptCacheKeyStripped(input, stubCtx, okEvents);

  assertEquals(Object.hasOwn(input.payload, 'prompt_cache_key'), false);
});
