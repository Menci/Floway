import { test } from 'vitest';

import { handleSpeedFast } from '../../../src/pipelines/anthropic-messages/handle-speed-fast.ts';
import { inspectStages, type StageFixture } from '../inspect.ts';
import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';
import { assertEquals, stubUpstreamModel } from '@floway-dev/test-utils';

const makeCtx = (speed?: unknown): StageFixture<'anthropicMessages'> => ({
  payload: {
    model: 'claude-opus-4.6-fast',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 128,
    ...(speed !== undefined ? { speed: speed as AnthropicMessagesPayload['speed'] } : {}),
  },
  headers: new Headers(),
  anthropicBeta: [],
  model: stubUpstreamModel({ endpoints: { anthropicMessages: {} } }),
});

test('handleSpeedFast strips speed=standard (semantically equivalent to omitted)', async () => {
  const ctx = await inspectStages('anthropicMessages', handleSpeedFast, makeCtx('standard'), ({ stream }) => ({ kind: 'stream', stream: stream([]) }));

  assertEquals('speed' in ctx.payload, false);
});
