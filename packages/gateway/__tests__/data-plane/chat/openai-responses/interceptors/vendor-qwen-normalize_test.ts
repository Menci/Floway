import { test } from 'vitest';

import type { OpenAIResponsesInvocation } from '../../../../../src/data-plane/chat/openai-responses/interceptors/types.ts';
import { withVendorQwenOpenAIResponsesNormalize } from '../../../../../src/data-plane/chat/openai-responses/interceptors/vendor-qwen-normalize.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import { eventResult, type FlagId } from '@floway-dev/upstream';

const stubCtx = mockChatGatewayCtx();

const okEvents = () =>
  Promise.resolve(
    eventResult(
      (async function* () {
        yield doneFrame();
      })(),
      testTelemetryModelIdentity,
    ),
  );

const invocation = (payload: CanonicalOpenAIResponsesPayload, enabledFlags: ReadonlySet<FlagId> = new Set(['vendor-qwen'])): OpenAIResponsesInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'openaiResponses',
  headers: new Headers(),
  action: 'generate',
});

test("vendor-qwen translates canonical reasoning.effort: 'none' into top-level enable_thinking:false", async () => {
  const input = invocation({
    model: 'qwen-max',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    reasoning: { effort: 'none' },
  });

  await withVendorQwenOpenAIResponsesNormalize(input, stubCtx, okEvents);

  const out = input.payload as unknown as Record<string, unknown>;
  assertEquals(out.reasoning, undefined);
  assertEquals(out.enable_thinking, false);
});
