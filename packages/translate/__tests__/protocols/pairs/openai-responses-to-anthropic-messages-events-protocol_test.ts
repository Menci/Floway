import { test } from 'vitest';

import { buildSourceEventsFor, emptyPayload, pairs } from '../../composition/helpers.ts';
import { fixtureFrames } from '../../ir/translation-cases.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
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

test('translateToSourceEvents stops after Anthropic Messages message_stop', async () => {
  async function* stream(): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEventEx>> {
    yield* fixtureFrames('anthropic-messages', {});
    yield eventFrame({
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: 'ignored after message_stop',
      },
    });
  }

  const frames = await collect(translate(stream()));

  assertEquals(
    frames.map(frame => (frame.type === 'event' ? frame.event.type : frame.type)),
    ['response.created', 'response.in_progress', 'response.output_item.added', 'response.output_item.done', 'response.completed'],
  );
});

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
      code: 'overloaded_error',
      sequence_number: 0,
    }),
  );
});

test('translateToSourceEvents rejects truncated Anthropic Messages streams without message_stop', async () => {
  async function* stream(): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEventEx>> {
    yield eventFrame({
      type: 'message_start',
      message: {
        container: null, diagnostics: null, stop_details: null,
        id: 'msg_truncated',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { cache_creation: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null, input_tokens: 1, output_tokens: 0 },
      },
    });
  }

  await assertRejects(async () => await drain(translate(stream())), Error, 'Messages stream ended without message_stop');
});
