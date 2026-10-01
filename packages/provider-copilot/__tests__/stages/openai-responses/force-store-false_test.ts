import { test } from 'vitest';

import { copilotOpenAIResponsesForceStoreFalse } from '../../../src/stages/openai-responses/force-store-false.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { applyProviderStage, type OpenAIResponsesProbe, type ExecuteResult, eventResult } from '@floway-dev/test-utils';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<OpenAIResponsesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: CanonicalOpenAIResponsesPayload): OpenAIResponsesProbe => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { openaiResponses: {} } }),
  action: 'generate',
});

test('forces store:false when the caller requested store:true', async () => {
  const ctx = invocation({ model: 'gpt-test', input: [{ type: 'message', role: 'user', content: 'hello' }], store: true });

  await applyProviderStage(copilotOpenAIResponsesForceStoreFalse, ctx, okEvents);

  assertEquals(ctx.payload.store, false);
});

test('sets store:false when the caller omitted store', async () => {
  const ctx = invocation({ model: 'gpt-test', input: [{ type: 'message', role: 'user', content: 'hello' }] });

  await applyProviderStage(copilotOpenAIResponsesForceStoreFalse, ctx, okEvents);

  assertEquals(ctx.payload.store, false);
});

test('leaves an explicit store:false untouched', async () => {
  const ctx = invocation({ model: 'gpt-test', input: [{ type: 'message', role: 'user', content: 'hello' }], store: false });

  await applyProviderStage(copilotOpenAIResponsesForceStoreFalse, ctx, okEvents);

  assertEquals(ctx.payload.store, false);
});
