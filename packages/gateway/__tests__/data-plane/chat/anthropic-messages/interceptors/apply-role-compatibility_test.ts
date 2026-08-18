import { test } from 'vitest';

import { withRoleCompatibilityApplied } from '../../../../../src/data-plane/chat/anthropic-messages/interceptors/apply-role-compatibility.ts';
import type { AnthropicMessagesInvocation } from '../../../../../src/data-plane/chat/anthropic-messages/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import type { AnthropicMessagesMessage, AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { type ExecuteResult, eventResult, type FlagId } from '@floway-dev/provider';
import { assert, assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const gatewayCtx = mockChatGatewayCtx();
const okEvents = (): Promise<ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEvent>> {})(), testTelemetryModelIdentity));

const applyRoles = async (
  messages: AnthropicMessagesMessage[],
  enabledFlags: ReadonlySet<FlagId>,
  targetApi: AnthropicMessagesInvocation['targetApi'] = 'messages',
): Promise<AnthropicMessagesMessage[]> => {
  const payload: AnthropicMessagesPayload = { model: 'test-model', max_tokens: 1, messages };
  const invocation: AnthropicMessagesInvocation = {
    payload,
    candidate: stubModelCandidate({ enabledFlags }),
    targetApi,
    headers: new Headers(),
  };
  await withRoleCompatibilityApplied(invocation, gatewayCtx, okEvents);
  return invocation.payload.messages;
};

test('leaves roles unchanged without the flag or at a translated target', async () => {
  const messages: AnthropicMessagesMessage[] = [{ role: 'system', content: 'inline rules' }];
  assertEquals(await applyRoles(messages, new Set()), messages);
  assertEquals(
    await applyRoles(messages, new Set(['rewrite-mid-conv-system-to-user']), 'responses'),
    messages,
  );
});

test('rewrites every inline system message and preserves content', async () => {
  const content = [{ type: 'text' as const, text: 'inline rules' }];
  assertEquals(
    await applyRoles(
      [
        { role: 'system', content: 'first rules' },
        { role: 'user', content: 'hello' },
        { role: 'system', content },
      ],
      new Set(['rewrite-mid-conv-system-to-user']),
    ),
    [
      { role: 'user', content: 'first rules' },
      { role: 'user', content: 'hello' },
      { role: 'user', content },
    ],
  );
  const result = await applyRoles(
    [{ role: 'system', content }],
    new Set(['rewrite-mid-conv-system-to-user']),
  );
  assert(result[0]?.content === content);
});

test('handles empty input and leaves non-system messages unchanged', async () => {
  assertEquals(await applyRoles([], new Set(['rewrite-mid-conv-system-to-user'])), []);
  const messages: AnthropicMessagesMessage[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ];
  assertEquals(await applyRoles(messages, new Set(['rewrite-mid-conv-system-to-user'])), messages);
});
