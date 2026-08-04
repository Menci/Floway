import { test } from 'vitest';

import { resolveMessagesReasoningEffort } from '../../../src/shared/messages-via/reasoning-effort.ts';
import { messagesReasoningFieldsFromEffort } from '../../../src/shared/via-messages/reasoning-effort.ts';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import { assertEquals } from '@floway-dev/test-utils';

test('effort none becomes the Messages native disable shape rather than an output_config level', () => {
  assertEquals(messagesReasoningFieldsFromEffort('none'), { thinking: { type: 'disabled' } });
});

test('every other effort passes through to output_config verbatim', () => {
  for (const effort of ['minimal', 'low', 'medium', 'high', 'max', 'vendor-specific-level']) {
    assertEquals(messagesReasoningFieldsFromEffort(effort), { effort });
  }
});

test('an absent effort selects neither slot', () => {
  assertEquals(messagesReasoningFieldsFromEffort(undefined), {});
  assertEquals(messagesReasoningFieldsFromEffort(null), {});
  assertEquals(messagesReasoningFieldsFromEffort(''), {});
});

// The two helpers are inverses: what `messages-via` reads off a Messages
// payload is what `via-messages` must put back. Disabled thinking is the case
// where the two protocols disagree on which slot holds the intent, so it is
// the one worth pinning.
test('disabled thinking survives the Messages round trip', () => {
  const payload: MessagesPayload = {
    model: 'test',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Hi' }],
    ...messagesReasoningFieldsFromEffort('none'),
  };

  assertEquals(resolveMessagesReasoningEffort(payload), 'none');
});
