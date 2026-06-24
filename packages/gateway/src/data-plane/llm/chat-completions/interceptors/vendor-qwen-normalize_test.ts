import { test } from 'vitest';

import type { ChatCompletionsInvocation } from './types.ts';
import { withVendorQwenChatCompletionsNormalize } from './vendor-qwen-normalize.ts';
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

const invocation = (payload: ChatCompletionsPayload, enabledFlags: ReadonlySet<string> = new Set(['vendor-qwen'])): ChatCompletionsInvocation => ({
  payload,
  candidate: stubProviderCandidate({ targetApi: 'chat-completions', binding: { enabledFlags } }),
  headers: new Headers(),
});

const okEvents = () => Promise.resolve(eventResult((async function* () {})(), testTelemetryModelIdentity));

test("translates canonical reasoning_effort: 'none' into top-level enable_thinking:false", async () => {
  const ctx = invocation({
    model: 'qwen-max',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'none',
  });

  let observed: ChatCompletionsPayload | null = null;
  await withVendorQwenChatCompletionsNormalize(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  const out = observed! as unknown as Record<string, unknown>;
  assertEquals(out.reasoning_effort, undefined);
  assertEquals(out.enable_thinking, false);
});

test('leaves a real reasoning_effort value untouched (only the none sentinel triggers the rewrite)', async () => {
  const ctx = invocation({
    model: 'qwen-max',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'high',
  });

  let observed: ChatCompletionsPayload | null = null;
  await withVendorQwenChatCompletionsNormalize(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  assertEquals(observed!.reasoning_effort, 'high');
  const out = observed! as unknown as Record<string, unknown>;
  assertEquals(out.enable_thinking, undefined);
});

test('early-returns when its flag is not set on the binding', async () => {
  const ctx = invocation(
    {
      model: 'qwen-max',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'none',
    },
    new Set(),
  );

  let observed: ChatCompletionsPayload | null = null;
  await withVendorQwenChatCompletionsNormalize(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  assertEquals(observed!.reasoning_effort, 'none');
  const out = observed! as unknown as Record<string, unknown>;
  assertEquals(out.enable_thinking, undefined);
});
