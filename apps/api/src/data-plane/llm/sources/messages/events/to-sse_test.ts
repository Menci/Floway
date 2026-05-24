import { test } from 'vitest';

import { messagesProtocolFrameToSSEFrame } from './to-sse.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEventData } from '@floway-dev/protocols/messages';

test('messagesProtocolFrameToSSEFrame serializes events without owning termination', () => {
  const frames = [eventFrame({ type: 'message_stop' } satisfies MessagesStreamEventData), eventFrame({ type: 'ping' } satisfies MessagesStreamEventData)].map(messagesProtocolFrameToSSEFrame);

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
    } satisfies MessagesStreamEventData),
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
