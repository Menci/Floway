import { test } from 'vitest';

import { withRoleCompatibilityApplied } from './apply-role-compatibility.ts';
import type { MessagesInvocation } from './types.ts';
import { mockChatGatewayCtx } from '../../../../test-helpers/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesMessage, MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { type ExecuteResult, eventResult, type FlagId } from '@floway-dev/provider';
import { assert, assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const gatewayCtx = mockChatGatewayCtx();
const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {})(), testTelemetryModelIdentity));

const applyRoles = async (
  messages: MessagesMessage[],
  enabledFlags: ReadonlySet<FlagId>,
  targetApi: MessagesInvocation['targetApi'] = 'messages',
): Promise<MessagesMessage[]> => {
  const payload: MessagesPayload = { model: 'test-model', max_tokens: 1, messages };
  const invocation: MessagesInvocation = {
    payload,
    candidate: stubModelCandidate({ enabledFlags }),
    targetApi,
    headers: new Headers(),
  };
  await withRoleCompatibilityApplied(invocation, gatewayCtx, okEvents);
  return invocation.payload.messages;
};

test('leaves roles unchanged without the flag or at a translated target', async () => {
  const messages: MessagesMessage[] = [{ role: 'system', content: 'inline rules' }];
  assertEquals(await applyRoles(messages, new Set()), messages);
  assertEquals(
    await applyRoles(messages, new Set(['demote-interleaved-system-to-user']), 'responses'),
    messages,
  );
});

test('demotes every inline system message and preserves content', async () => {
  const content = [{ type: 'text' as const, text: 'inline rules' }];
  assertEquals(
    await applyRoles(
      [
        { role: 'system', content: 'first rules' },
        { role: 'user', content: 'hello' },
        { role: 'system', content },
      ],
      new Set(['demote-interleaved-system-to-user']),
    ),
    [
      { role: 'user', content: 'first rules' },
      { role: 'user', content: 'hello' },
      { role: 'user', content },
    ],
  );
  const result = await applyRoles(
    [{ role: 'system', content }],
    new Set(['demote-interleaved-system-to-user']),
  );
  assert(result[0]?.content === content);
});

test('handles empty input and leaves non-system messages unchanged', async () => {
  assertEquals(await applyRoles([], new Set(['demote-interleaved-system-to-user'])), []);
  const messages: MessagesMessage[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ];
  assertEquals(await applyRoles(messages, new Set(['demote-interleaved-system-to-user'])), messages);
});
