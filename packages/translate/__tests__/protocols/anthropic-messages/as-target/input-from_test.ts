import { test } from 'vitest';

import type { IRInputTurnWithCallIds } from '../../../../src/composition/request/call-ids.ts';
import { anthropicMessagesConversationFromIR } from '../../../../src/protocols/anthropic-messages/as-target/input-from.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('writes a content-backed IR document as a native Messages document', () => {
  const turns: IRInputTurnWithCallIds[] = [{
    kind: 'client',
    items: [{
      type: 'message', role: 'user', content: [
        {
          type: 'document',
          document: {
            source: {
              source_kind: 'content',
              content: [
                { type: 'text', text: 'caption' },
                { type: 'image', image: { source_kind: 'base64', media_type: 'image/png', data: 'AAAA' } },
              ],
            },
          },
        },
      ],
    }],
  }];

  assertEquals(anthropicMessagesConversationFromIR(turns, true), {
    system: [],
    messages: [{
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'content',
            content: [
              { type: 'text', text: 'caption' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
            ],
          },
        },
      ],
    }],
  });
});
