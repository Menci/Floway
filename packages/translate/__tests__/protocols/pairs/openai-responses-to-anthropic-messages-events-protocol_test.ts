import { test } from 'vitest';

import { buildSourceEventsFor, emptyPayload, pairs } from '../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import { fixtureFrames } from '../fixtures.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const codec = createTestSidecarCodec();
const translate = (frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>) => buildSourceEventsFor(
  pairs.responsesToMessages[0], pairs.responsesToMessages[1], emptyPayload.responses, { sidecarCodec: codec }, frames,
);

const drain = async <T>(frames: AsyncIterable<T>): Promise<void> => {
  for await (const _frame of frames) {
    // Exhaust the stream so async translator errors surface to the caller.
  }
};

const collect = async <T>(frames: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const frame of frames) collected.push(frame);
  return collected;
};

test('translateToSourceEvents translates Anthropic Messages error terminal and stops', async () => {
  async function* stream(): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEventEx>> {
    yield eventFrame({
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: 'upstream overloaded',
      },
    });
    yield eventFrame({ type: 'message_stop' });
  }

  const frames = await collect(translate(stream()));

  assertEquals(frames.length, 1);
  assertEquals(
    frames[0],
    eventFrame({
      type: 'error',
      message: 'upstream overloaded',
      provider_specific_fields: { type: 'overloaded_error' },
      sequence_number: 0,
    }),
  );
});
