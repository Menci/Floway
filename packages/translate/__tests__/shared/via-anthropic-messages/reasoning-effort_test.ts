import { test } from 'vitest';

import { resolveAnthropicMessagesReasoningEffort } from '../../../src/shared/anthropic-messages-via/reasoning-effort.ts';
import { anthropicMessagesReasoningFieldsFromEffort } from '../../../src/shared/via-anthropic-messages/reasoning-effort.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals } from '@floway-dev/test-utils';

test('effort none becomes the Anthropic Messages native disable shape rather than an output_config level', () => {
  assertEquals(anthropicMessagesReasoningFieldsFromEffort('none'), { thinking: { type: 'disabled' } });
});

test('every other effort passes through to output_config verbatim', () => {
  for (const effort of ['minimal', 'low', 'medium', 'high', 'max', 'vendor-specific-level']) {
    assertEquals(anthropicMessagesReasoningFieldsFromEffort(effort), { effort });
  }
});

test('an absent effort selects neither slot', () => {
  assertEquals(anthropicMessagesReasoningFieldsFromEffort(undefined), {});
  assertEquals(anthropicMessagesReasoningFieldsFromEffort(null), {});
  assertEquals(anthropicMessagesReasoningFieldsFromEffort(''), {});
});

// The two helpers are inverses: what `anthropic-messages-via` reads off an Anthropic Messages
// payload is what `via-anthropic-messages` must put back. Disabled thinking is the case
// where the two protocols disagree on which slot holds the intent, so it is
// the one worth pinning.
test('disabled thinking survives the Anthropic Messages round trip', () => {
  const payload: AnthropicMessagesPayload = {
    model: 'test',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Hi' }],
    ...anthropicMessagesReasoningFieldsFromEffort('none'),
  };

  assertEquals(resolveAnthropicMessagesReasoningEffort(payload), 'none');
});
