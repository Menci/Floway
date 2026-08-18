import { test } from 'vitest';

import type { OpenAIChatCompletionsInvocation } from '../../../../../src/data-plane/chat/openai-chat-completions/interceptors/types.ts';
import { withVendorQwenOpenAIChatCompletionsNormalize } from '../../../../../src/data-plane/chat/openai-chat-completions/interceptors/vendor-qwen-normalize.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';
import { eventResult, type FlagId } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx = mockChatGatewayCtx();

const invocation = (payload: OpenAIChatCompletionsPayload, enabledFlags: ReadonlySet<FlagId> = new Set(['vendor-qwen'])): OpenAIChatCompletionsInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'openai-chat-completions',
  headers: new Headers(),
});

const okEvents = () => Promise.resolve(eventResult((async function* () {})(), testTelemetryModelIdentity));

test("translates canonical reasoning_effort: 'none' into top-level enable_thinking:false", async () => {
  const ctx = invocation({
    model: 'qwen-max',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'none',
  });

  let observed: OpenAIChatCompletionsPayload | null = null;
  await withVendorQwenOpenAIChatCompletionsNormalize(ctx, stubCtx, () => {
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

  let observed: OpenAIChatCompletionsPayload | null = null;
  await withVendorQwenOpenAIChatCompletionsNormalize(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  assertEquals(observed!.reasoning_effort, 'high');
  const out = observed! as unknown as Record<string, unknown>;
  assertEquals(out.enable_thinking, undefined);
});

test('early-returns when its flag is not set on the candidate', async () => {
  const ctx = invocation(
    {
      model: 'qwen-max',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'none',
    },
    new Set(),
  );

  let observed: OpenAIChatCompletionsPayload | null = null;
  await withVendorQwenOpenAIChatCompletionsNormalize(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  assertEquals(observed!.reasoning_effort, 'none');
  const out = observed! as unknown as Record<string, unknown>;
  assertEquals(out.enable_thinking, undefined);
});
