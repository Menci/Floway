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

test('leaves roles unchanged without flags or at a translated target', async () => {
  const messages: OpenAIChatCompletionsMessage[] = [
    { role: 'system', content: 'rules' },
    { role: 'developer', content: 'developer rules' },
  ];

  assertEquals(await applyRoles(messages, new Set()), messages);
  assertEquals(
    await applyRoles(messages, new Set(['rewrite-system-to-developer']), 'openaiResponses'),
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
