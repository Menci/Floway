import { test } from 'vitest';

import { withRoleCompatibilityApplied } from '../../../../../src/data-plane/chat/chat-completions/interceptors/apply-role-compatibility.ts';
import type { ChatCompletionsInvocation } from '../../../../../src/data-plane/chat/chat-completions/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import type { ChatCompletionsMessage, ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import { eventResult, type FlagId } from '@floway-dev/provider';
import { assert, assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const gatewayCtx = mockChatGatewayCtx();
const okEvents = () => Promise.resolve(eventResult((async function* () {})(), testTelemetryModelIdentity));

const applyRoles = async (
  messages: ChatCompletionsMessage[],
  enabledFlags: ReadonlySet<FlagId>,
  targetApi: ChatCompletionsInvocation['targetApi'] = 'chat-completions',
): Promise<ChatCompletionsMessage[]> => {
  const payload: ChatCompletionsPayload = { model: 'test-model', messages };
  const invocation: ChatCompletionsInvocation = {
    payload,
    candidate: stubModelCandidate({ enabledFlags }),
    targetApi,
    headers: new Headers(),
  };
  await withRoleCompatibilityApplied(invocation, gatewayCtx, okEvents);
  return invocation.payload.messages;
};

test('leaves roles unchanged without flags or at a translated target', async () => {
  const messages: ChatCompletionsMessage[] = [
    { role: 'system', content: 'rules' },
    { role: 'developer', content: 'developer rules' },
  ];

  assertEquals(await applyRoles(messages, new Set()), messages);
  assertEquals(
    await applyRoles(messages, new Set(['rewrite-system-to-developer']), 'responses'),
    messages,
  );
});

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

test('preserves the leading system run and rewrites later system messages', async () => {
  assertEquals(
    await applyRoles(
      [
        { role: 'system', content: 'base A' },
        { role: 'system', content: 'base B' },
        { role: 'user', content: 'hello' },
        { role: 'system', content: 'inline rules' },
      ],
      new Set(['rewrite-mid-conv-system-to-user']),
    ),
    [
      { role: 'system', content: 'base A' },
      { role: 'system', content: 'base B' },
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'inline rules' },
    ],
  );
});

test('keeps a leading-only system run and an empty input unchanged', async () => {
  const leading: ChatCompletionsMessage[] = [
    { role: 'system', content: 'base A' },
    { role: 'system', content: 'base B' },
  ];
  assertEquals(await applyRoles(leading, new Set(['rewrite-mid-conv-system-to-user'])), leading);
  assertEquals(await applyRoles([], new Set(['rewrite-mid-conv-system-to-user'])), []);
});

test('preserves multipart content identity when rewriting a mid-conversation system message', async () => {
  const content = [
    { type: 'text' as const, text: 'one' },
    { type: 'text' as const, text: 'two' },
  ];
  const result = await applyRoles(
    [{ role: 'user', content: 'hello' }, { role: 'system', content }],
    new Set(['rewrite-mid-conv-system-to-user']),
  );
  assertEquals(result, [{ role: 'user', content: 'hello' }, { role: 'user', content }]);
  assert(result[1]?.content === content);
});

test('applies overlapping flags in system-to-developer then developer-to-system order', async () => {
  assertEquals(
    await applyRoles(
      [
        { role: 'system', content: 'base rules' },
        { role: 'user', content: 'hello' },
        { role: 'system', content: 'inline rules' },
      ],
      new Set([
        'rewrite-system-to-developer',
        'rewrite-developer-to-system',
        'rewrite-mid-conv-system-to-user',
      ]),
    ),
    [
      { role: 'system', content: 'base rules' },
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'inline rules' },
    ],
  );
});
