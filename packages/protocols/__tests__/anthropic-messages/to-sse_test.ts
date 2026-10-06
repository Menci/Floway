import { test } from 'vitest';

import type { AnthropicMessagesStreamEventEx } from '../../src/anthropic-messages/index.ts';
import { anthropicMessagesProtocolFrameToSSEFrame } from '../../src/anthropic-messages/to-sse.ts';
import { eventFrame } from '../../src/common/index.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('anthropicMessagesProtocolFrameToSSEFrame serializes events without owning termination', () => {
  const frames = [eventFrame({ type: 'message_stop' } satisfies AnthropicMessagesStreamEventEx), eventFrame({ type: 'ping' } satisfies AnthropicMessagesStreamEventEx)].map(anthropicMessagesProtocolFrameToSSEFrame);

  assertEquals(
    frames.map(frame => frame?.event),
    ['message_stop', 'ping'],
  );
});

test('anthropicMessagesProtocolFrameToSSEFrame preserves search_result_location source', () => {
  const frame = anthropicMessagesProtocolFrameToSSEFrame(
    eventFrame({
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'citations_delta',
        citation: {
          cited_text: '',
          type: 'search_result_location',
          source: 'https://example.com/protocol',
          title: 'Protocol Citation',
          search_result_index: 0,
          start_block_index: 0,
          end_block_index: 0,
        },
      },
    } satisfies AnthropicMessagesStreamEventEx),
  );

  const payload = JSON.parse(frame!.data) as {
    delta: { citation: Record<string, unknown> };
  };

  assertEquals(payload.delta.citation, {
    cited_text: '',
    type: 'search_result_location',
    source: 'https://example.com/protocol',
    title: 'Protocol Citation',
    search_result_index: 0,
    start_block_index: 0,
    end_block_index: 0,
  });
});
