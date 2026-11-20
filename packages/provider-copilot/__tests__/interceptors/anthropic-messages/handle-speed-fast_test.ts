import { test } from 'vitest';

import { withSpeedFast } from '../../../src/interceptors/anthropic-messages/handle-speed-fast.ts';
import type { AnthropicMessagesBoundaryCtx } from '../../../src/interceptors/anthropic-messages/types.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const makeCtx = (speed?: unknown): AnthropicMessagesBoundaryCtx => ({
  payload: {
    model: 'claude-opus-4.6-fast',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 128,
    ...(speed !== undefined ? { speed: speed as AnthropicMessagesPayload['speed'] } : {}),
  },
  headers: new Headers(),
  anthropicBeta: [],
  model: stubProviderModel({ endpoints: { anthropicMessages: {} } }),
});

const stubRequest = {};

const streamResult = (frames: ProtocolFrame<AnthropicMessagesStreamEventEx>[]): ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEventEx>> =>
  eventResult(
    (async function* (): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEventEx>> {
      for (const frame of frames) yield frame;
    })(),
    testTelemetryModelIdentity,
  );

test('withSpeedFast strips speed=standard (semantically equivalent to omitted)', async () => {
  const ctx = makeCtx('standard');

  await withSpeedFast(ctx, stubRequest, () => Promise.resolve(streamResult([])));

  assertEquals('speed' in ctx.payload, false);
});
