import { test } from 'vitest';

import { chatCompletionsInvocation, stubRequestContext, testTelemetryModelIdentity } from './test-helpers.ts';
import { withVendorQwenChatCompletionsNormalize } from './vendor-qwen-normalize.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { eventResult } from '../../../shared/errors/result.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';

const okEvents = () => Promise.resolve(eventResult((async function* () { yield* []; })(), testTelemetryModelIdentity));

test("vendor-qwen translates canonical reasoning_effort: 'none' into top-level enable_thinking:false", async () => {
  const ctx = chatCompletionsInvocation(
    {
      model: 'qwen-max',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'none',
    },
    new Set(['vendor-qwen']),
  );

  let observed: ChatCompletionsPayload | null = null;
  await withVendorQwenChatCompletionsNormalize(ctx, stubRequestContext, () => {
    observed = ctx.payload;
    return okEvents();
  });

  const out = observed! as unknown as Record<string, unknown>;
  assertEquals(out.reasoning_effort, undefined);
  assertEquals(out.enable_thinking, false);
});

test('vendor-qwen leaves a real reasoning_effort value untouched (only the none sentinel triggers the rewrite)', async () => {
  const ctx = chatCompletionsInvocation(
    {
      model: 'qwen-max',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'high',
    },
    new Set(['vendor-qwen']),
  );

  let observed: ChatCompletionsPayload | null = null;
  await withVendorQwenChatCompletionsNormalize(ctx, stubRequestContext, () => {
    observed = ctx.payload;
    return okEvents();
  });

  assertEquals(observed!.reasoning_effort, 'high');
  const out = observed! as unknown as Record<string, unknown>;
  assertEquals(out.enable_thinking, undefined);
});

test('vendor-qwen early-returns when its flag is not set on the binding', async () => {
  const ctx = chatCompletionsInvocation(
    {
      model: 'qwen-max',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'none',
    },
    new Set(),
  );

  let observed: ChatCompletionsPayload | null = null;
  await withVendorQwenChatCompletionsNormalize(ctx, stubRequestContext, () => {
    observed = ctx.payload;
    return okEvents();
  });

  assertEquals(observed!.reasoning_effort, 'none');
  const out = observed! as unknown as Record<string, unknown>;
  assertEquals(out.enable_thinking, undefined);
});
