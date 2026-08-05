import { test } from 'vitest';

import { eventFrame } from '../../src/common/index.ts';
import type { MessagesStreamEvent } from '../../src/messages/index.ts';
import { messagesProtocolFrameToSSEFrame } from '../../src/messages/to-sse.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('messagesProtocolFrameToSSEFrame serializes events without owning termination', () => {
  const frames = [eventFrame({ type: 'message_stop' } satisfies MessagesStreamEvent), eventFrame({ type: 'ping' } satisfies MessagesStreamEvent)].map(messagesProtocolFrameToSSEFrame);

  assertEquals(
    frames.map(frame => frame?.event),
    ['message_stop', 'ping'],
  );
});

test('messagesProtocolFrameToSSEFrame maps search_result_location url to SSE source', () => {
  const frame = messagesProtocolFrameToSSEFrame(
    eventFrame({
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'citations_delta',
        citation: {
          type: 'search_result_location',
          url: 'https://example.com/protocol',
          title: 'Protocol Citation',
          search_result_index: 0,
          start_block_index: 0,
          end_block_index: 0,
        },
      },
    } satisfies MessagesStreamEvent),
  );

  const payload = JSON.parse(frame!.data) as {
    delta: { citation: Record<string, unknown> };
  };

  assertEquals(payload.delta.citation, {
    type: 'search_result_location',
    source: 'https://example.com/protocol',
    title: 'Protocol Citation',
    search_result_index: 0,
    start_block_index: 0,
    end_block_index: 0,
  });
});

test('messagesProtocolFrameToSSEFrame preserves an explicitly empty cited_text', () => {
  const frame = messagesProtocolFrameToSSEFrame(eventFrame({
    type: 'content_block_delta',
    index: 0,
    delta: {
      type: 'citations_delta',
      citation: {
        type: 'search_result_location',
        url: 'https://example.com/empty',
        title: 'Empty excerpt',
        search_result_index: 0,
        start_block_index: 0,
        end_block_index: 0,
        cited_text: '',
      },
    },
  }));

  assertEquals((JSON.parse(frame!.data) as { delta: { citation: { cited_text?: string } } }).delta.citation.cited_text, '');
});

test.each([
  { type: 'char_location', cited_text: 'quote', document_index: 0, document_title: null, start_char_index: 0, end_char_index: 5, file_id: null },
  { type: 'content_block_location', cited_text: 'quote', document_index: 0, document_title: null, start_block_index: 0, end_block_index: 1, file_id: null },
  { type: 'page_location', cited_text: 'quote', document_index: 0, document_title: null, start_page_number: 1, end_page_number: 1, file_id: null },
] as const)('messagesProtocolFrameToSSEFrame preserves $type citations', citation => {
  const frame = messagesProtocolFrameToSSEFrame(eventFrame({
    type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation },
  }));
  assertEquals((JSON.parse(frame!.data) as { delta: { citation: unknown } }).delta.citation, citation);
});

test('messagesProtocolFrameToSSEFrame preserves nullable citation lists', () => {
  const event = {
    type: 'content_block_start' as const,
    index: 0,
    content_block: { type: 'text' as const, text: '', citations: null },
  };
  assertEquals(JSON.parse(messagesProtocolFrameToSSEFrame(eventFrame(event))!.data), event);
});
