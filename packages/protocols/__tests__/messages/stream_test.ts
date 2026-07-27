import { test } from 'vitest';

import { parseMessagesStream } from '../../src/messages/stream.ts';
import { sseFrame, sseFrameBody } from '../common/test-utils.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

test('parseMessagesStream parses Messages SSE frames into protocol events', async () => {
  const frames = await collect(parseMessagesStream(sseFrameBody(
    sseFrame('', 'ping'),
    sseFrame(
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
    ),
    sseFrame('[DONE]'),
  )));

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

test('parseMessagesStream rejects malformed Messages SSE JSON', async () => {
  await assertRejects(
    async () => {
      await collect(parseMessagesStream(sseFrameBody(
        sseFrame('not json', 'message_delta'),
      )));
    },
    Error,
    'Malformed upstream Messages SSE JSON for event "message_delta": not json',
  );
});
