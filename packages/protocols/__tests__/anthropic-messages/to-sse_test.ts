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
