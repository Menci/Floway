import { test } from 'vitest';

import { withReasoningDisabledOnForcedToolChoice } from '../../../../../src/data-plane/chat/openai-chat-completions/interceptors/disable-reasoning-on-forced-tool-choice.ts';
import type { OpenAIChatCompletionsInvocation } from '../../../../../src/data-plane/chat/openai-chat-completions/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import { eventResult, type FlagId } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx = mockChatGatewayCtx();

const okEvents = () => Promise.resolve(eventResult((async function* () {})(), testTelemetryModelIdentity));

const invocation = (
  payload: OpenAIChatCompletionsPayload,
  enabledFlags: ReadonlySet<FlagId> = new Set(['disable-reasoning-on-forced-tool-choice']),
): OpenAIChatCompletionsInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'openaiChatCompletions',
  headers: new Headers(),
});

test('required tool_choice sets reasoning_effort to the canonical none sentinel', async () => {
  const input = invocation({
    model: 'm',
    messages: [],
    reasoning_effort: 'high',
    tool_choice: 'required',
  });

  await withReasoningDisabledOnForcedToolChoice(input, stubCtx, okEvents);

  assertEquals(input.payload.reasoning_effort, 'none');
});
