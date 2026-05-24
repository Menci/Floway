import { test } from 'vitest';

import { messagesStreamFramesToEvents } from './emit.ts';
import { assertEquals, assertRejects } from '../../../../test-assert.ts';
import { sseFrame } from '@floway-dev/protocols/common';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

test('messagesStreamFramesToEvents parses Messages SSE frames into protocol events', async () => {
  const frames = await collect(
    messagesStreamFramesToEvents(
      (async function* () {
        yield sseFrame('', 'ping');
        yield sseFrame(
          JSON.stringify({
            type: 'message_start',
            message: {
              id: 'msg_1',
              type: 'message',
              role: 'assistant',
              content: [],
              model: 'claude-test',
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 0 },
            },
          }),
          'message_start',
        );
        yield sseFrame('[DONE]');
      })(),
    ),
  );

  assertEquals(
    frames.map(frame => frame.type),
    ['event', 'done'],
  );
  assertEquals(frames[0], {
    type: 'event',
    event: {
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    },
  });
});

test('messagesStreamFramesToEvents rejects malformed Messages SSE JSON', async () => {
  await assertRejects(
    async () => {
      await collect(
        messagesStreamFramesToEvents(
          (async function* () {
            yield sseFrame('not json', 'message_delta');
          })(),
        ),
      );
    },
    Error,
    'Malformed upstream Messages SSE JSON for event "message_delta": not json',
  );
});
