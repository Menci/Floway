import { test } from 'vitest';

import type { OpenAIChatCompletionsInvocation } from '../../../../../src/data-plane/chat/openai-chat-completions/interceptors/types.ts';
import { withVendorQwenOpenAIChatCompletionsNormalize } from '../../../../../src/data-plane/chat/openai-chat-completions/interceptors/vendor-qwen-normalize.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import { eventResult, type FlagId } from '@floway-dev/upstream';

const stubCtx = mockChatGatewayCtx();

const invocation = (payload: OpenAIChatCompletionsPayloadEx, enabledFlags: ReadonlySet<FlagId> = new Set(['vendor-qwen'])): OpenAIChatCompletionsInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'openaiChatCompletions',
  headers: new Headers(),
});

const okEvents = () => Promise.resolve(eventResult((async function* () {})(), testTelemetryModelIdentity));

test("translates canonical reasoning_effort: 'none' into top-level enable_thinking:false", async () => {
  const ctx = invocation({
    model: 'qwen-max',
    messages: [{ role: 'user', content: 'hi' }],
    reasoning_effort: 'none',
  });

  let observed: OpenAIChatCompletionsPayloadEx | null = null;
  await withVendorQwenOpenAIChatCompletionsNormalize(ctx, stubCtx, () => {
    observed = ctx.payload;
    return okEvents();
  });

  const out = observed! as unknown as Record<string, unknown>;
  assertEquals(out.reasoning_effort, undefined);
  assertEquals(out.enable_thinking, false);
});
