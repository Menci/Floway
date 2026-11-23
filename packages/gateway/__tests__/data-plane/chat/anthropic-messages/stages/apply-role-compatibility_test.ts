import { expect, test } from 'vitest';

import { applyRoleCompatibility } from '../../../../../src/data-plane/chat/anthropic-messages/stages/apply-role-compatibility.ts';
import { driveChatStages } from '../../shared/drive-stages.ts';
import { messagesPayload, messagesUpstream } from '../fixture.ts';
import type { AnthropicMessagesMessage } from '@floway-dev/protocols/anthropic-messages';

const rewriteMessages = async (messages: AnthropicMessagesMessage[]) => {
  const { request } = await driveChatStages([applyRoleCompatibility], {
    'request.payload': messagesPayload({ messages }),
    'route.candidate': messagesUpstream({ flags: ['rewrite-disallowed-mid-conv-system-to-user'] }).candidate,
  }, { key: 'response.anthropicMessages' });
  return request['request.payload'].messages;
};

test('rewrites only content-bearing system messages in disallowed Anthropic positions', async () => {
  const directive = { role: 'system' as const, content: [], output_config: { effort: 'high' as const } };
  const invalidContent = [{ type: 'text' as const, text: 'skills' }];
  const messages: AnthropicMessagesMessage[] = [
    { role: 'user', content: 'AGENTS' }, directive, { role: 'system', content: invalidContent }, { role: 'user', content: 'current question' },
  ];
  expect(await rewriteMessages(messages)).toEqual([messages[0], directive, { role: 'user', content: invalidContent }, messages[3]]);
});

test('preserves valid content-bearing system turn boundaries', async () => {
  const cases: AnthropicMessagesMessage[][] = [
    [{ role: 'user', content: 'question' }, { role: 'system', content: 'rules' }, { role: 'assistant', content: 'answer' }],
    [{ role: 'user', content: 'question' }, { role: 'system', content: 'rules' }],
    [
      { role: 'assistant', content: [{ type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [] }] },
      { role: 'system', content: 'updated context' },
    ],
  ];
  for (const messages of cases) expect(await rewriteMessages(messages)).toEqual(messages);
});
