import { test } from 'vitest';

import { withRoleCompatibilityApplied } from '../../../../../src/data-plane/chat/anthropic-messages/interceptors/apply-role-compatibility.ts';
import type { AnthropicMessagesInvocation } from '../../../../../src/data-plane/chat/anthropic-messages/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import type { AnthropicMessagesMessage, AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { type ExecuteResult, eventResult, type FlagId } from '@floway-dev/provider';
import { assert, assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const gatewayCtx = mockChatGatewayCtx();
const okEvents = (): Promise<ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEventEx>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEventEx>> {})(), testTelemetryModelIdentity));

const applyRoles = async (
  messages: AnthropicMessagesMessage[],
  enabledFlags: ReadonlySet<FlagId>,
  targetApi: AnthropicMessagesInvocation['targetApi'] = 'anthropicMessages',
): Promise<AnthropicMessagesMessage[]> => {
  const payload: AnthropicMessagesPayload = { model: 'test-model', max_tokens: 1, messages };
  const invocation: AnthropicMessagesInvocation = {
    payload,
    candidate: stubModelCandidate({ enabledFlags }),
    targetApi,
    headers: new Headers(),
    anthropicBeta: [],
  };
  await withRoleCompatibilityApplied(invocation, gatewayCtx, okEvents);
  return invocation.payload.messages;
};

test('leaves roles unchanged without the flag or at a translated target', async () => {
  const messages: AnthropicMessagesMessage[] = [{ role: 'system', content: 'inline rules' }];
  assertEquals(await applyRoles(messages, new Set()), messages);
  assertEquals(
    await applyRoles(messages, new Set(['rewrite-mid-conv-system-to-user']), 'openaiResponses'),
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

test('rewrites only content-bearing system messages in disallowed Anthropic positions', async () => {
  const directive = { role: 'system' as const, content: [], output_config: { effort: 'high' as const } };
  const invalidContent = [{ type: 'text' as const, text: 'skills' }];
  const result = await applyRoles(
    [
      { role: 'user', content: 'AGENTS' },
      directive,
      { role: 'system', content: invalidContent },
      { role: 'user', content: 'current question' },
    ],
    new Set(['rewrite-disallowed-mid-conv-system-to-user']),
  );

  assertEquals(result, [
    { role: 'user', content: 'AGENTS' },
    directive,
    { role: 'user', content: invalidContent },
    { role: 'user', content: 'current question' },
  ]);
  assert(result[1] === directive);
  assert(result[2]?.content === invalidContent);
});

test('preserves valid content-bearing system turn boundaries', async () => {
  const flag = new Set<FlagId>(['rewrite-disallowed-mid-conv-system-to-user']);
  const beforeAssistant: AnthropicMessagesMessage[] = [
    { role: 'user', content: 'question' },
    { role: 'system', content: 'rules' },
    { role: 'assistant', content: 'answer' },
  ];
  const atEnd: AnthropicMessagesMessage[] = [
    { role: 'user', content: 'question' },
    { role: 'system', content: 'rules' },
  ];
  const afterServerToolResult: AnthropicMessagesMessage[] = [
    {
      role: 'assistant',
      content: [{ type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] }],
    },
    { role: 'system', content: 'updated context' },
  ];

  assertEquals(await applyRoles(beforeAssistant, flag), beforeAssistant);
  assertEquals(await applyRoles(atEnd, flag), atEnd);
  assertEquals(await applyRoles(afterServerToolResult, flag), afterServerToolResult);
});

test('rewrites first and post-assistant content-bearing system messages as invalid', async () => {
  const messages: AnthropicMessagesMessage[] = [
    { role: 'system', content: 'leading inline rules' },
    { role: 'assistant', content: 'answer' },
    { role: 'system', content: 'late rules' },
  ];

  assertEquals(
    await applyRoles(messages, new Set(['rewrite-disallowed-mid-conv-system-to-user'])),
    [
      { role: 'user', content: 'leading inline rules' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'late rules' },
    ],
  );
});
