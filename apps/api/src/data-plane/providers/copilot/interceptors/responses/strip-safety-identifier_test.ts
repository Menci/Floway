import { test } from 'vitest';

import { withSafetyIdentifierStripped } from './strip-safety-identifier.ts';
import { assertEquals, assertFalse } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import type { LlmSourceApi, RequestContext, ResponsesInvocation } from '../../../../llm/interceptors.ts';
import { eventResult, type ExecuteResult } from '../../../../llm/shared/errors/result.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  runtimeLocation: 'test',
  clientStream: false,
};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: ResponsesPayload, sourceApi: LlmSourceApi = 'responses'): ResponsesInvocation => ({
  sourceApi,
  targetApi: 'responses',
  model: payload.model,
  upstream: 'test-upstream',
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set<string>(),
  headers: {},
});

test('safety_identifier is preserved when a native Responses caller supplied it', async () => {
  // Native Responses clients can legitimately set safety_identifier and OpenAI
  // proper accepts it. Stripping it on the gateway would silently mutate a
  // first-class caller intent.
  const ctx = invocation({
    model: 'gpt-test',
    input: 'hello',
    safety_identifier: 'caller-supplied-id',
  });

  await withSafetyIdentifierStripped(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.safety_identifier, 'caller-supplied-id');
});

test('safety_identifier is stripped when the request was translated from Messages', async () => {
  // Anthropic-source clients have no canonical equivalent; any value here was
  // synthesized during translation, so we drop it to match caozhiyuan's
  // never-emit behavior on the Anthropic-to-Responses path.
  const ctx = invocation(
    {
      model: 'gpt-test',
      input: 'hello',
      safety_identifier: 'synthesized-during-translate',
    },
    'messages',
  );

  await withSafetyIdentifierStripped(ctx, stubRequest, okEvents);

  assertFalse('safety_identifier' in ctx.payload);
});

test('safety_identifier is stripped when the request was translated from Chat Completions', async () => {
  const ctx = invocation(
    {
      model: 'gpt-test',
      input: 'hello',
      safety_identifier: 'synthesized-during-translate',
    },
    'chat-completions',
  );

  await withSafetyIdentifierStripped(ctx, stubRequest, okEvents);

  assertFalse('safety_identifier' in ctx.payload);
});

test('payload without safety_identifier is left untouched', async () => {
  const payload: ResponsesPayload = { model: 'gpt-test', input: 'hello' };
  const ctx = invocation(payload);

  await withSafetyIdentifierStripped(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload, { model: 'gpt-test', input: 'hello' });
});
