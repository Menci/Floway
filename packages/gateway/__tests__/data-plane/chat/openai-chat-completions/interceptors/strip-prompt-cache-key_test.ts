import { test } from 'vitest';

import { withPromptCacheKeyStripped } from '../../../../../src/data-plane/chat/openai-chat-completions/interceptors/strip-prompt-cache-key.ts';
import type { OpenAIChatCompletionsInvocation } from '../../../../../src/data-plane/chat/openai-chat-completions/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import { eventResult, type FlagId } from '@floway-dev/upstream';

const stubCtx = mockChatGatewayCtx();

const okEvents = () => Promise.resolve(eventResult((async function* () {})(), testTelemetryModelIdentity));

const invocation = (
  payload: OpenAIChatCompletionsPayloadEx,
  enabledFlags: ReadonlySet<FlagId> = new Set(['strip-prompt-cache-key']),
): OpenAIChatCompletionsInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'openaiChatCompletions',
  headers: new Headers(),
});

test('drops top-level prompt_cache_key when the flag is on', async () => {
  const input = invocation({
    model: 'm',
    messages: [],
    prompt_cache_key: 'thread-42',
  });

  await withPromptCacheKeyStripped(input, stubCtx, okEvents);

  assertEquals(Object.hasOwn(input.payload, 'prompt_cache_key'), false);
});
