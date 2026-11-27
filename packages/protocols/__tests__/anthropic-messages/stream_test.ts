import { expect, test } from 'vitest';

import { decodeAnthropicMessagesStream, parseAnthropicMessagesStream } from '../../src/anthropic-messages/stream.ts';
import { sseByteStream, sseFrame, sseFrameBody } from '../common/test-utils.ts';
import { assertRejects } from '@floway-dev/test-utils';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

test('parseAnthropicMessagesStream rejects malformed Anthropic Messages SSE JSON', async () => {
  await assertRejects(
    async () => {
      await collect(parseAnthropicMessagesStream(sseFrameBody(
        sseFrame('not json', 'message_delta'),
      )));
    },
    Error,
  );
});

test.each([
  ['message_start', 'message'],
  ['content_block_start', 'content_block'],
  ['content_block_delta', 'delta'],
  ['message_delta', 'delta'],
])('Anthropic Messages rejects a malformed %s object before emitting a typed event', async (type, field) => {
  const event = { type, [field]: null };
  const body = sseByteStream(sseFrame(JSON.stringify(event), type), sseFrame('{"type":"message_stop"}'));
  expect(await collect(decodeAnthropicMessagesStream(body))).toMatchObject([
    {
      ok: false,
      error: { kind: 'protocol', event, eventName: type, cause: { cause: null, message: expect.stringContaining(`${type}.${field}`) } },
    },
  ]);
});
