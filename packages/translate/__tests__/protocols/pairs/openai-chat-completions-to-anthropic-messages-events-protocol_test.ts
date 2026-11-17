import { test } from 'vitest';

import { buildSourceEventsFor, emptyPayload, pairs } from '../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const codec = createTestSidecarCodec();
const translate = (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>) => buildSourceEventsFor(
  pairs.chatToMessages[0], pairs.chatToMessages[1], emptyPayload.chat, { sidecarCodec: codec }, frames,
);

const drain = async <T>(frames: AsyncIterable<T>): Promise<void> => {
  for await (const _frame of frames) {
    // Exhaust the stream so async translator errors surface to the caller.
  }
};

test('translateToSourceEvents emits native ChatCompletions errors for Messages failures', async () => {
  async function* stream(): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEventEx>> {
    yield eventFrame({
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: 'upstream overloaded',
      },
    });
  }

  const frames = [];
  for await (const frame of translate(stream())) frames.push(frame);
  assertEquals(frames, [eventFrame({ error: { type: 'overloaded_error', message: 'upstream overloaded' } })]);
});
