import { test } from 'vitest';

import { withStoreForcedFalse } from './force-store-false.ts';
import type { ResponsesBoundaryCtx } from './types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: ResponsesPayload): ResponsesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { responses: {} } }),
  action: 'generate',
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
