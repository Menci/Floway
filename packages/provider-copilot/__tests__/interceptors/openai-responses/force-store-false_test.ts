import { test } from 'vitest';

import { withStoreForcedFalse } from '../../../src/interceptors/openai-responses/force-store-false.ts';
import type { OpenAIResponsesBoundaryCtx } from '../../../src/interceptors/openai-responses/types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: CanonicalOpenAIResponsesPayload): OpenAIResponsesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { openaiResponses: {} } }),
  action: 'generate',
});

test('forces store:false when the caller requested store:true', async () => {
  const ctx = invocation({ model: 'gpt-test', input: [{ type: 'message', role: 'user', content: 'hello' }], store: true });

  await withStoreForcedFalse(ctx, okEvents);

  assertEquals(ctx.payload.store, false);
});

test('sets store:false when the caller omitted store', async () => {
  const ctx = invocation({ model: 'gpt-test', input: [{ type: 'message', role: 'user', content: 'hello' }] });

  await withStoreForcedFalse(ctx, okEvents);

  assertEquals(ctx.payload.store, false);
});

test('leaves an explicit store:false untouched', async () => {
  const ctx = invocation({ model: 'gpt-test', input: [{ type: 'message', role: 'user', content: 'hello' }], store: false });

  await withStoreForcedFalse(ctx, okEvents);

  assertEquals(ctx.payload.store, false);
});
