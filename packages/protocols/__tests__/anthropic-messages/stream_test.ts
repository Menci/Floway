import { expect, test } from 'vitest';

import { parseAnthropicMessagesStream } from '../../src/anthropic-messages/stream.ts';
import { sseFrame, sseFrameBody } from '../common/test-utils.ts';

test('parseAnthropicMessagesStream yields malformed SSE JSON as its last frame', async () => {
  const frames = parseAnthropicMessagesStream(sseFrameBody(sseFrame('not json', 'message_delta'), sseFrame('[DONE]')));

  const parsed = await Array.fromAsync(frames);
  expect(parsed).toMatchObject([
    { type: 'error', cause: { message: 'Malformed upstream Anthropic Messages SSE JSON for event "message_delta": not json', cause: expect.any(SyntaxError) } },
  ]);
  const [failure] = parsed;
  if (failure?.type !== 'error') throw new TypeError('Expected the parser error');
  expect(failure.cause).toBeInstanceOf(Error);
  expect(failure.cause.stack).toContain(failure.cause.message);
});
