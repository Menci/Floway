import { test } from 'vitest';

import { disableAnthropicMessagesReasoningOnForcedToolChoice } from '../../../../../src/data-plane/chat/anthropic-messages/interceptors/disable-reasoning-on-forced-tool-choice.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals } from '@floway-dev/test-utils';

test('messages forced tool_choice preserves structured-output format while stripping reasoning effort', () => {
  const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false };
  const input: AnthropicMessagesPayload = {
    model: 'm',
    messages: [],
    max_tokens: 1,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    output_config: { effort: 'high', format: { type: 'json_schema', schema } },
    tool_choice: { type: 'tool', name: 'x' },
  };
  const shaped = disableAnthropicMessagesReasoningOnForcedToolChoice(input);

  assertEquals(shaped.thinking, { type: 'disabled' });
  assertEquals(shaped.output_config, { format: { type: 'json_schema', schema } });
});
