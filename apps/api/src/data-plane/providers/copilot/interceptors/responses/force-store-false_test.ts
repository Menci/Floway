import { test } from 'vitest';

import { withStoreForcedFalse } from './force-store-false.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import type { RequestContext, ResponsesInvocation } from '../../../../llm/interceptors.ts';
import { eventResult, type ExecuteResult } from '../../../../llm/shared/errors/result.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload, RawResponsesStreamEvent } from '@floway-dev/protocols/responses';

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  statefulResponsesContext: { privatePayload: new Map(), newSyntheticIds: new Set() },  runtimeLocation: 'test',
  clientStream: false,
};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<RawResponsesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<RawResponsesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: ResponsesPayload): ResponsesInvocation => ({
  sourceApi: 'responses',
  targetApi: 'responses',
  model: payload.model,
  upstream: 'test-upstream',
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set<string>(),
  headers: {},
});

test('forces store:false when the caller requested store:true', async () => {
  const ctx = invocation({ model: 'gpt-test', input: 'hello', store: true });

  await withStoreForcedFalse(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.store, false);
});

test('sets store:false when the caller omitted store', async () => {
  const ctx = invocation({ model: 'gpt-test', input: 'hello' });

  await withStoreForcedFalse(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.store, false);
});

test('leaves an explicit store:false untouched', async () => {
  const ctx = invocation({ model: 'gpt-test', input: 'hello', store: false });

  await withStoreForcedFalse(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.store, false);
});
