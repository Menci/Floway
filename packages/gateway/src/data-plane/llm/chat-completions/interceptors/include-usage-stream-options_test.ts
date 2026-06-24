import { test } from 'vitest';

import { withUsageStreamOptionsIncluded } from './include-usage-stream-options.ts';
import type { ChatCompletionsInvocation } from './types.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx: GatewayCtx = {
  apiKeyId: 'test-key',
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
};

const okEvents = () => Promise.resolve(eventResult((async function* () {})(), testTelemetryModelIdentity));

const invocation = (payload: ChatCompletionsPayload): ChatCompletionsInvocation => ({
  payload,
  candidate: stubProviderCandidate({ targetApi: 'chat-completions' }),
  headers: new Headers(),
});

test('adds stream_options.include_usage when stream_options is absent', async () => {
  const input = invocation({ model: 'm', messages: [] });

  await withUsageStreamOptionsIncluded(input, stubCtx, okEvents);

  assertEquals(input.payload.stream_options, { include_usage: true });
});

test('overrides include_usage:false on an existing stream_options object', async () => {
  const input = invocation({
    model: 'm',
    messages: [],
    stream_options: { include_usage: false },
  });

  await withUsageStreamOptionsIncluded(input, stubCtx, okEvents);

  assertEquals(input.payload.stream_options, { include_usage: true });
});

test('preserves sibling stream_options keys while forcing include_usage on', async () => {
  // Upstreams that pass through unknown fields can carry extra `stream_options`
  // keys past our typed surface; the interceptor must not drop them when it
  // flips include_usage.
  const input = invocation({
    model: 'm',
    messages: [],
    stream_options: { extra: 'keep-me', include_usage: false } as unknown as ChatCompletionsPayload['stream_options'],
  });

  await withUsageStreamOptionsIncluded(input, stubCtx, okEvents);

  assertEquals(input.payload.stream_options as unknown as Record<string, unknown>, {
    extra: 'keep-me',
    include_usage: true,
  });
});
