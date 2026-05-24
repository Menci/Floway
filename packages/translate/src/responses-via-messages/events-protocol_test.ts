import { test } from 'vitest';

import { translateToSourceEvents } from './events.ts';
import { assertEquals, assertRejects } from '../test-assert.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEventData } from '@floway-dev/protocols/messages';

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

test('translateToSourceEvents stops after Messages message_stop', async () => {
  async function* stream(): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> {
    yield eventFrame({ type: 'message_stop' });
    yield eventFrame({
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: 'ignored after message_stop',
      },
    });
  }

  const frames = await collect(translateToSourceEvents(stream(), 'resp_123', 'gpt-test'));

  assertEquals(
    frames.map(frame => (frame.type === 'event' ? frame.event.type : frame.type)),
    ['response.completed'],
  );
});

test('translateToSourceEvents translates Messages error terminal and stops', async () => {
  async function* stream(): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> {
    yield eventFrame({
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: 'upstream overloaded',
      },
    });
    yield eventFrame({ type: 'message_stop' });
  }

  const frames = await collect(translateToSourceEvents(stream(), 'resp_123', 'gpt-test'));

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

test('translateToSourceEvents rejects truncated Messages streams without message_stop', async () => {
  async function* stream(): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> {
    yield eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_truncated',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
  }

  await assertRejects(async () => await drain(translateToSourceEvents(stream(), 'resp_123', 'gpt-test')), Error, 'Upstream Messages stream ended without a message_stop event.');
});
