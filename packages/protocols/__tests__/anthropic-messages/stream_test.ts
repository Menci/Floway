import { test } from 'vitest';

import { parseAnthropicMessagesStream } from '../../src/anthropic-messages/stream.ts';
import { sseFrame, sseFrameBody } from '../common/test-utils.ts';
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
    'Malformed upstream Anthropic Messages SSE JSON for event "message_delta": not json',
  );
});
