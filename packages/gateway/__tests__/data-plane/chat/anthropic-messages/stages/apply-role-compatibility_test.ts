import { test } from 'vitest';

import { applyAnthropicMessagesRoleCompatibility } from '../../../../../src/data-plane/chat/anthropic-messages/stages/apply-role-compatibility.ts';
import type { AnthropicMessagesMessage } from '@floway-dev/protocols/anthropic-messages';
import type { FlagId } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const applyRoles = (messages: AnthropicMessagesMessage[], flags: ReadonlySet<FlagId>): AnthropicMessagesMessage[] =>
  applyAnthropicMessagesRoleCompatibility({ messages }, [...flags]).messages;

test('rewrites only content-bearing system messages in disallowed Anthropic positions', () => {
  const directive = { role: 'system' as const, content: [], output_config: { effort: 'high' as const } };
  const invalidContent = [{ type: 'text' as const, text: 'skills' }];
  const result = applyRoles(
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
});

test('preserves valid content-bearing system turn boundaries', () => {
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

  assertEquals(applyRoles(beforeAssistant, flag), beforeAssistant);
  assertEquals(applyRoles(atEnd, flag), atEnd);
  assertEquals(applyRoles(afterServerToolResult, flag), afterServerToolResult);
});
