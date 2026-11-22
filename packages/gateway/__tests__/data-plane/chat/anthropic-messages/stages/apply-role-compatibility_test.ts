import { expect, test } from 'vitest';

import { anthropicFacts, anthropicPayload } from './fixtures.ts';
import { applyRoleCompatibility } from '../../../../../src/data-plane/chat/anthropic-messages/stages/apply-role-compatibility.ts';
import { runChatStage } from '../../../../test-utils/chat-pipeline.ts';
import type { AnthropicMessagesMessage } from '@floway-dev/protocols/anthropic-messages';

const applyRoles = async (messages: AnthropicMessagesMessage[], flags: readonly import('@floway-dev/provider').FlagId[]): Promise<AnthropicMessagesMessage[]> => {
  const { outcome } = await runChatStage({
    stage: applyRoleCompatibility,
    facts: anthropicFacts(anthropicPayload({ messages }), { enabledFlags: flags }),
    next: facts => facts['request.payload'],
  });
  return outcome.messages;
};

test('rewrites only content-bearing system messages in disallowed positions', async () => {
  const directive = { role: 'system' as const, content: [], output_config: { effort: 'high' as const } };
  const invalid = [{ type: 'text' as const, text: 'skills' }];
  expect(await applyRoles([
    { role: 'user', content: 'AGENTS' },
    directive,
    { role: 'system', content: invalid },
    { role: 'user', content: 'current question' },
  ], ['rewrite-disallowed-mid-conv-system-to-user'])).toEqual([
    { role: 'user', content: 'AGENTS' },
    directive,
    { role: 'user', content: invalid },
    { role: 'user', content: 'current question' },
  ]);
});

test('preserves valid system placement and can rewrite every inline system turn', async () => {
  const valid: AnthropicMessagesMessage[] = [
    { role: 'user', content: 'question' },
    { role: 'system', content: 'rules' },
    { role: 'assistant', content: 'answer' },
  ];
  expect(await applyRoles(valid, ['rewrite-disallowed-mid-conv-system-to-user'])).toEqual(valid);
  expect(await applyRoles(valid, ['rewrite-mid-conv-system-to-user'])).toEqual([
    { role: 'user', content: 'question' },
    { role: 'user', content: 'rules' },
    { role: 'assistant', content: 'answer' },
  ]);
});
