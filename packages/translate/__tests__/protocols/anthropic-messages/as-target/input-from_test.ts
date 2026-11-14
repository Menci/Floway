import { test } from 'vitest';

import type { IRInputTurnWithCallIds } from '../../../../src/composition/request/call-ids.ts';
import { anthropicMessagesConversationFromIR } from '../../../../src/protocols/anthropic-messages/as-target/input-from.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('writes a content-backed IR document as a native Messages document', () => {
  const citation = {
    type: 'char_location' as const, cited_text: 'caption', document_index: 0, document_title: null,
    start_char_index: 0, end_char_index: 7,
  };
  const turns: IRInputTurnWithCallIds[] = [{
    kind: 'client',
    items: [{
      type: 'message', role: 'user', content: [
        {
          type: 'document',
          document: {
            title: 'Report',
            context: 'USD',
            citations: { enabled: true },
            cache_control: { type: 'ephemeral', ttl: '1h' },
            source: {
              source_kind: 'content',
              content: [
                { type: 'text', text: 'caption', citations: [citation], cache_control: null },
                { type: 'image', image: { source_kind: 'base64', media_type: 'image/png', data: 'AAAA' }, transformations: { oversized_image: 'downsize' }, cache_control: { type: 'ephemeral' } },
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
          title: 'Report',
          context: 'USD',
          citations: { enabled: true },
          cache_control: { type: 'ephemeral', ttl: '1h' },
          source: {
            type: 'content',
            content: [
              { type: 'text', text: 'caption', citations: [citation], cache_control: null },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' }, transformations: { oversized_image: 'downsize' }, cache_control: { type: 'ephemeral' } },
            ],
          },
        },
      ],
    }],
  });
});

test('writes null document metadata and leaves absent metadata absent', () => {
  const turns: IRInputTurnWithCallIds[] = [{
    kind: 'client', items: [{
      type: 'message', role: 'user', content: [
        { type: 'document', document: { source: { source_kind: 'text', media_type: 'text/plain', text: 'a' } } },
        { type: 'document', document: { source: { source_kind: 'text', media_type: 'text/plain', text: 'b' }, title: null, context: null, citations: null, cache_control: null } },
      ],
    }],
  }];
  assertEquals(anthropicMessagesConversationFromIR(turns, true).messages, [{
    role: 'user', content: [
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'a' } },
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'b' }, title: null, context: null, citations: null, cache_control: null },
    ],
  }]);
});

test('writes metadata for both text and media document sources', () => {
  const turns: IRInputTurnWithCallIds[] = [{
    kind: 'client', items: [{
      type: 'message', role: 'user', content: [
        { type: 'document', document: { source: { source_kind: 'text', media_type: 'text/plain', text: 'body' }, title: 'Text', citations: {} } },
        { type: 'document', document: { source: { source_kind: 'media', media: { source_kind: 'file', file_id: 'file_1' } }, title: 'File', cache_control: { type: 'ephemeral', ttl: '5m' } } },
      ],
    }],
  }];
  assertEquals(anthropicMessagesConversationFromIR(turns, true).messages, [{
    role: 'user', content: [
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'body' }, title: 'Text', citations: {} },
      { type: 'document', source: { type: 'file', file_id: 'file_1' }, title: 'File', cache_control: { type: 'ephemeral', ttl: '5m' } },
    ],
  }]);
});
