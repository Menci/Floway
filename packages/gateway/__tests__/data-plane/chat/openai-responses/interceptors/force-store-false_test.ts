import { test } from 'vitest';

import { withStoreForcedFalse } from '../../../../../src/data-plane/chat/openai-responses/interceptors/force-store-false.ts';
import type { OpenAIResponsesInvocation } from '../../../../../src/data-plane/chat/openai-responses/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { doneFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import { eventResult, type FlagId } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

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

const invocation = (
  payload: CanonicalOpenAIResponsesPayload,
  enabledFlags: ReadonlySet<FlagId> = new Set(['openai-responses-store-false']),
  targetApi: OpenAIResponsesInvocation['targetApi'] = 'openaiResponses',
): OpenAIResponsesInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi,
  headers: new Headers(),
  action: 'generate',
});

test('forces store:false over a caller-requested store:true when the flag is on', async () => {
  const ctx = invocation({
    model: 'gpt-5.2',
    store: true,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
  });

  await withStoreForcedFalse(ctx, stubCtx, okEvents);

  assertEquals(ctx.payload.store, false);
});

test('sets store:false when the caller omitted store', async () => {
  const ctx = invocation({
    model: 'gpt-5.2',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
  });

  await withStoreForcedFalse(ctx, stubCtx, okEvents);

  assertEquals(ctx.payload.store, false);
});

test('leaves an explicit store:false as false', async () => {
  const ctx = invocation({
    model: 'gpt-5.2',
    store: false,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
  });

  await withStoreForcedFalse(ctx, stubCtx, okEvents);

  assertEquals(ctx.payload.store, false);
});

test('leaves the payload untouched when the flag is off', async () => {
  const ctx = invocation(
    {
      model: 'gpt-5.2',
      store: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
    },
    new Set<FlagId>(),
  );

  await withStoreForcedFalse(ctx, stubCtx, okEvents);

  assertEquals(ctx.payload.store, true);
});

test('leaves the payload untouched when the final target is not OpenAI Responses', async () => {
  const ctx = invocation(
    {
      model: 'gpt-5.2',
      store: true,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
    },
    new Set(['openai-responses-store-false']),
    'anthropicMessages',
  );

  await withStoreForcedFalse(ctx, stubCtx, okEvents);

  assertEquals(ctx.payload.store, true);
});
