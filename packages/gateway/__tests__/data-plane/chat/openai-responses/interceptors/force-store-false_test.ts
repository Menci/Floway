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

test('when openai-responses-store-false is on, keep "store":false to false', async () => {
  const ctx = invocation({
    model: 'gpt-5.2',
    store: false,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
  });

  await withStoreForcedFalse(ctx, stubCtx, okEvents);

  assertEquals(ctx.payload.store, false);
});

test('when openai-responses-store-false is on, change "store":true to false', async () => {
  const ctx = invocation({
    model: 'gpt-5.2',
    store: true,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
  });

  await withStoreForcedFalse(ctx, stubCtx, okEvents);

  assertEquals(ctx.payload.store, false);
});

test('when openai-responses-store-false is on, change an unset "store" to false', async () => {
  const ctx = invocation({
    model: 'gpt-5.2',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
  });

  await withStoreForcedFalse(ctx, stubCtx, okEvents);

  assertEquals(ctx.payload.store, false);
});

test('when openai-responses-store-false is off, leave "store":true as is', async () => {
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

test('when openai-responses-store-false is off, leave "store":false as is', async () => {
  const ctx = invocation(
    {
      model: 'gpt-5.2',
      store: false,
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
    },
    new Set<FlagId>(),
  );

  await withStoreForcedFalse(ctx, stubCtx, okEvents);

  assertEquals(ctx.payload.store, false);
});

test('when openai-responses-store-false is off, leave an unset "store" as is', async () => {
  const ctx = invocation(
    {
      model: 'gpt-5.2',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
    },
    new Set<FlagId>(),
  );

  await withStoreForcedFalse(ctx, stubCtx, okEvents);

  assertEquals(ctx.payload.store, undefined);
});
