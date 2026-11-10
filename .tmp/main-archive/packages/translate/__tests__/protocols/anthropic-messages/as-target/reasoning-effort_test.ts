import { test } from 'vitest';

import { anthropicMessagesReasoningFieldsFromEffort } from '../../../../src/protocols/anthropic-messages/as-target/reasoning-effort.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('effort none becomes the Anthropic Messages native disable shape rather than an output_config level', () => {
  assertEquals(anthropicMessagesReasoningFieldsFromEffort('none'), { thinking: { type: 'disabled' } });
});

test('every other effort passes through to output_config verbatim', () => {
  for (const effort of ['', 'minimal', 'low', 'medium', 'high', 'max', 'vendor-specific-level']) {
    assertEquals(anthropicMessagesReasoningFieldsFromEffort(effort), { effort });
  }
});

test('an absent effort selects neither slot', () => {
  assertEquals(anthropicMessagesReasoningFieldsFromEffort(undefined), {});
  assertEquals(anthropicMessagesReasoningFieldsFromEffort(null), {});
});
