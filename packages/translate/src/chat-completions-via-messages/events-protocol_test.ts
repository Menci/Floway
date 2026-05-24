import { test } from 'vitest';

import { translateToSourceEvents } from './events.ts';
import { assertRejects } from '../test-assert.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEventData } from '@floway-dev/protocols/messages';

const drain = async <T>(frames: AsyncIterable<T>): Promise<void> => {
  for await (const _frame of frames) {
    // Exhaust the stream so async translator errors surface to the caller.
  }
};

test('translateToSourceEvents rejects Messages error events', async () => {
  async function* stream(): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> {
    yield eventFrame({
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: 'upstream overloaded',
      },
    });
  }

  await assertRejects(async () => await drain(translateToSourceEvents(stream())), Error, 'Upstream Messages stream error: overloaded_error: upstream overloaded');
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

  await assertRejects(async () => await drain(translateToSourceEvents(stream())), Error, 'Upstream Messages stream ended without a message_stop event.');
});
