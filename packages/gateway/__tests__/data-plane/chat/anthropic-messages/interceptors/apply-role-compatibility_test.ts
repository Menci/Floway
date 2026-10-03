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
  targetApi: AnthropicMessagesInvocation['targetApi'] = 'anthropicMessages',
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

test('force-rewrites every inline system message when the compatibility flag is enabled', async () => {
  const messages: AnthropicMessagesMessage[] = [
    { role: 'system', content: 'initial inline rules' },
    { role: 'user', content: 'first request' },
    { role: 'system', content: 'legal inline rules' },
  ];
  assertEquals(await applyRoles(messages, new Set(['rewrite-mid-conv-system-to-user'])), [
    { role: 'user', content: 'initial inline rules' },
    { role: 'user', content: 'first request' },
    { role: 'user', content: 'legal inline rules' },
  ]);
  assertEquals(
    await applyRoles(messages, new Set(['rewrite-mid-conv-system-to-user']), 'openaiResponses'),
    messages,
  );
});

test('preserves expressible inline system messages when the compatibility flag is disabled', async () => {
  const messages: AnthropicMessagesMessage[] = [
    { role: 'user', content: 'first request' },
    { role: 'system', content: 'rules for recorded reply' },
    { role: 'assistant', content: 'first reply' },
    { role: 'user', content: 'second request' },
    { role: 'system', content: 'rules for generated reply' },
  ];
  assertEquals(await applyRoles(messages, new Set()), messages);
});

test('lowers inline system messages whose position cannot be expressed', async () => {
  assertEquals(
    await applyRoles(
      [
        { role: 'system', content: 'leading rules' },
        { role: 'user', content: 'first request' },
        { role: 'system', content: 'rules followed by user' },
        { role: 'user', content: 'second request' },
        { role: 'assistant', content: 'reply' },
        { role: 'system', content: 'rules following assistant' },
        { role: 'assistant', content: 'another reply' },
      ],
      new Set(),
    ),
    [
      { role: 'user', content: 'leading rules' },
      { role: 'user', content: 'first request' },
      { role: 'user', content: 'rules followed by user' },
      { role: 'user', content: 'second request' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'rules following assistant' },
      { role: 'assistant', content: 'another reply' },
    ],
  );
});

test('preserves a valid consecutive inline system section', async () => {
  assertEquals(
    await applyRoles(
      [
        { role: 'user', content: 'request' },
        { role: 'system', content: 'first rules' },
        { role: 'system', content: 'second rules' },
        { role: 'assistant', content: 'reply' },
      ],
      new Set(),
    ),
    [
      { role: 'user', content: 'request' },
      { role: 'system', content: 'first rules' },
      { role: 'system', content: 'second rules' },
      { role: 'assistant', content: 'reply' },
    ],
  );
});

test('preserves an inline system section after an assistant server-tool result', async () => {
  const messages: AnthropicMessagesMessage[] = [
    { role: 'user', content: 'search for the latest release' },
    {
      role: 'assistant',
      content: [
        { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'latest release' } },
        {
          type: 'web_search_tool_result',
          tool_use_id: 'srvtoolu_1',
          content: [{ type: 'web_search_result', url: 'https://example.com', title: 'Result', encrypted_content: 'opaque' }],
        },
      ],
    },
    { role: 'system', content: 'Use only the retrieved source.' },
  ];

  assertEquals(await applyRoles(messages, new Set()), messages);
});

test.each([
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'tool_search_tool_result',
])('preserves an inline system section after %s', async type => {
  const messages = [
    { role: 'user', content: 'request' },
    { role: 'assistant', content: [{ type, tool_use_id: 'srvtoolu_1', content: [] }] },
    { role: 'system', content: 'Use the server result.' },
  ] as unknown as AnthropicMessagesMessage[];
  assertEquals(await applyRoles(messages, new Set()), messages);
});

test('preserves an effort-only system control at any position and with forced rewriting', async () => {
  const effort = { role: 'system' as const, content: [] as [], output_config: { effort: 'high' } };
  const messages: AnthropicMessagesMessage[] = [
    { role: 'assistant', content: 'answer' },
    effort,
    { role: 'user', content: 'next request' },
  ];
  assertEquals(await applyRoles(messages, new Set()), messages);
  assertEquals(await applyRoles(messages, new Set(['rewrite-mid-conv-system-to-user'])), messages);
});

test('judges text in a mixed effort/text system section by the ordinary placement rule', async () => {
  const effort = { role: 'system' as const, content: '', output_config: { effort: 'high' } };
  assertEquals(await applyRoles([
    { role: 'assistant', content: 'answer' },
    effort,
    { role: 'system', content: 'late rules' },
    { role: 'user', content: 'next request' },
  ], new Set()), [
    { role: 'assistant', content: 'answer' },
    effort,
    { role: 'user', content: 'late rules' },
    { role: 'user', content: 'next request' },
  ]);
});

test('lowers a system section after an ordinary assistant turn', async () => {
  assertEquals(
    await applyRoles([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
      { role: 'system', content: 'late rules' },
    ], new Set()),
    [
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'late rules' },
    ],
  );
});

test('preserves inline content identity while lowering its role', async () => {
  const content = [{ type: 'text' as const, text: 'inline rules' }];
  const result = await applyRoles([{ role: 'system', content }], new Set());
  assert(result[0]?.content === content);
});

test('handles empty input and leaves non-system messages unchanged', async () => {
  assertEquals(await applyRoles([], new Set()), []);
  const messages: AnthropicMessagesMessage[] = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: 'hi' },
  ];
  assertEquals(await applyRoles(messages, new Set()), messages);
});
