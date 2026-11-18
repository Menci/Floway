import { test } from 'vitest';

import { withRoleCompatibilityApplied } from '../../../../../src/data-plane/chat/openai-chat-completions/interceptors/apply-role-compatibility.ts';
import type { OpenAIChatCompletionsInvocation } from '../../../../../src/data-plane/chat/openai-chat-completions/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import type { OpenAIChatCompletionsMessage, OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import { eventResult, type FlagId } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const gatewayCtx = mockChatGatewayCtx();
const okEvents = () => Promise.resolve(eventResult((async function* () {})(), testTelemetryModelIdentity));

const applyRoles = async (
  messages: OpenAIChatCompletionsMessage[],
  enabledFlags: ReadonlySet<FlagId>,
  targetApi: OpenAIChatCompletionsInvocation['targetApi'] = 'openaiChatCompletions',
): Promise<OpenAIChatCompletionsMessage[]> => {
  const payload: OpenAIChatCompletionsPayload = { model: 'test-model', messages };
  const invocation: OpenAIChatCompletionsInvocation = {
    payload,
    candidate: stubModelCandidate({ enabledFlags }),
    targetApi,
    headers: new Headers(),
  };
  await withRoleCompatibilityApplied(invocation, gatewayCtx, okEvents);
  return invocation.payload.messages;
};

// The leading-system-run and flag-overlap orderings are proven through the
// native attempt chain in `attempt_test.ts`.
test('applies the system and developer rewrites independently', async () => {
  assertEquals(
    await applyRoles(
      [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hello' }],
      new Set(['rewrite-system-to-developer']),
    ),
    [{ role: 'developer', content: 'rules' }, { role: 'user', content: 'hello' }],
  );
  assertEquals(
    await applyRoles(
      [{ role: 'developer', content: 'rules' }, { role: 'user', content: 'hello' }],
      new Set(['rewrite-developer-to-system']),
    ),
    [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hello' }],
  );
});
