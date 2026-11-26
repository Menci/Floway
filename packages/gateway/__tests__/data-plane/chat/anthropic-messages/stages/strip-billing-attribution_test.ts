import { test } from 'vitest';

import { stripAnthropicMessagesBillingAttribution } from '../../../../../src/data-plane/chat/anthropic-messages/stages/strip-billing-attribution.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals } from '@floway-dev/test-utils';

test('deletes the system field entirely when every array block becomes empty', () => {
  const input: AnthropicMessagesPayload = {
    model: 'm',
    max_tokens: 1,
    messages: [],
    system: [
      { citations: null, type: 'text', text: 'x-anthropic-billing-header: token' },
      { citations: null, type: 'text', text: 'cch=deadbeef1234;' },
    ],
  };
  assertEquals('system' in stripAnthropicMessagesBillingAttribution(input), false);
  assertEquals(input.system?.length, 2);
});
