import { expect, test } from 'vitest';

import { anthropicFacts, anthropicPayload } from './fixtures.ts';
import { disableReasoningOnForcedToolChoice } from '../../../../../src/data-plane/chat/anthropic-messages/stages/disable-reasoning-on-forced-tool-choice.ts';
import { runChatStage } from '../../../../test-utils/chat-pipeline.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

const nextPayload = async (payload: AnthropicMessagesPayload, flag: boolean): Promise<AnthropicMessagesPayload> => {
  const { outcome } = await runChatStage({
    stage: disableReasoningOnForcedToolChoice,
    facts: anthropicFacts(payload, {
      enabledFlags: flag ? ['disable-reasoning-on-forced-tool-choice'] : [],
    }),
    next: facts => facts['request.payload'],
  });
  return outcome;
};

test('disabled reasoning preserves structured-output format on forced tool choice', async () => {
  const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] };
  expect(await nextPayload(anthropicPayload({
    thinking: { type: 'enabled', budget_tokens: 1024 },
    output_config: { effort: 'high', format: { type: 'json_schema', schema } },
    tool_choice: { type: 'tool', name: 'lookup' },
  }), true)).toMatchObject({
    thinking: { type: 'disabled' },
    output_config: { format: { type: 'json_schema', schema } },
  });
});

test('flag and forced choice are both required', async () => {
  const payload = anthropicPayload({ tool_choice: { type: 'any' }, thinking: { type: 'enabled', budget_tokens: 32 } });
  expect(await nextPayload(payload, false)).toBe(payload);
  expect(await nextPayload(anthropicPayload({ tool_choice: { type: 'auto' }, thinking: { type: 'enabled', budget_tokens: 32 } }), true)).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 32 } });
});
