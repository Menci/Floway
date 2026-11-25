import { expect, test } from 'vitest';

import { parseAnthropicMessagesStream } from '../../src/anthropic-messages/stream.ts';
import { sseFrame, sseFrameBody } from '../common/test-utils.ts';

test('parseAnthropicMessagesStream yields malformed SSE JSON as its last frame', async () => {
  const frames = parseAnthropicMessagesStream(sseFrameBody(sseFrame('not json', 'message_delta'), sseFrame('[DONE]')));

  expect(await Array.fromAsync(frames)).toEqual([
    { type: 'error', cause: { message: 'Malformed upstream Anthropic Messages SSE JSON for event "message_delta": not json', cause: expect.any(SyntaxError) } },
  ]);
});
