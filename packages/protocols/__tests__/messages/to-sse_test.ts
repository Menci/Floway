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
