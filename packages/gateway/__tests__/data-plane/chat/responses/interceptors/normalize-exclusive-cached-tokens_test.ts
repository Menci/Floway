import { expect, test } from 'vitest';

import { withExclusiveCachedTokensNormalized } from '../../../../../src/data-plane/chat/responses/interceptors/normalize-exclusive-cached-tokens.ts';
import type { ResponsesInvocation } from '../../../../../src/data-plane/chat/responses/interceptors/types.ts';
import { billableUsageFromResponsesResult } from '../../../../../src/data-plane/chat/responses/usage.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type ExecuteResult, eventResult, type FlagId } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx = mockChatGatewayCtx();

const invocation = (
  enabledFlags: ReadonlySet<FlagId> = new Set(['usage-exclusive-cached-tokens']),
  targetApi: ResponsesInvocation['targetApi'] = 'responses',
): ResponsesInvocation => ({
  payload: { model: 'test-model', input: [{ type: 'message', role: 'user', content: 'hi' }] },
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi,
  headers: new Headers(),
  action: 'generate',
});

// Same accounting as the Charm Hyper Chat Completions capture, in Responses
// field names: 479 + 13312 + 373 = 14164, so total_tokens witnesses it.
const exclusiveUsage = (): NonNullable<ResponsesResult['usage']> => ({
  input_tokens: 479,
  output_tokens: 373,
  total_tokens: 14164,
  input_tokens_details: { cached_tokens: 13312 },
});

const completedEvent = (usage: NonNullable<ResponsesResult['usage']>): ResponsesStreamEvent => ({
  type: 'response.completed',
  sequence_number: 0,
  response: {
    id: 'resp_test',
    object: 'response',
    model: 'test-model',
    status: 'completed',
    output: [],
    output_text: '',
    error: null,
    incomplete_details: null,
    usage,
  },
});

const run = async (ctx: ResponsesInvocation, usage: NonNullable<ResponsesResult['usage']>): Promise<ResponsesResult> => {
  const result: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> = await withExclusiveCachedTokensNormalized(ctx, stubCtx, () =>
    Promise.resolve(eventResult(
      (async function* () {
        yield eventFrame(completedEvent(usage));
      })(),
      testTelemetryModelIdentity,
    )));
  if (result.type !== 'events') throw new Error('expected events result');
  const frames: ProtocolFrame<ResponsesStreamEvent>[] = [];
  for await (const frame of result.events) frames.push(frame);
  assertEquals(frames.length, 1);
  const frame = frames[0];
  if (frame.type !== 'event') throw new Error('expected event frame');
  if (!('response' in frame.event)) throw new Error('expected a response-carrying event');
  return frame.event.response;
};

const exclusiveUsageWithoutTotal = (): NonNullable<ResponsesResult['usage']> => {
  const { total_tokens: _withheld, ...rest } = exclusiveUsage();
  return rest as NonNullable<ResponsesResult['usage']>;
};

const inclusiveUsage = (): NonNullable<ResponsesResult['usage']> => ({
  input_tokens: 1000,
  output_tokens: 50,
  total_tokens: 1050,
  input_tokens_details: { cached_tokens: 400 },
});

test('folds on the totals alone, with no flag set', async () => {
  const response = await run(invocation(new Set()), exclusiveUsage());
  assertEquals(response.usage?.input_tokens, 13791);
  assertEquals(response.usage?.total_tokens, 14164);
  assertEquals(response.usage?.input_tokens_details, { cached_tokens: 13312 });
});

test('folds on the flag when the totals witness nothing', async () => {
  const response = await run(invocation(), exclusiveUsageWithoutTotal());
  assertEquals(response.usage?.input_tokens, 13791);
});

test('leaves a normalized response billable instead of underflowing', async () => {
  expect(() => billableUsageFromResponsesResult({ usage: exclusiveUsage() })).toThrowError(RangeError);

  const response = await run(invocation(new Set()), exclusiveUsage());
  assertEquals(
    billableUsageFromResponsesResult(response),
    { input: 479, cacheRead: 13312, cacheWrite: 0, cacheWrite1h: 0, output: 373 },
  );
});

test('folds cache writes back as well', async () => {
  const response = await run(invocation(), {
    input_tokens: 100,
    output_tokens: 10,
    input_tokens_details: { cached_tokens: 120, cache_write_tokens: 80 },
  } as unknown as NonNullable<ResponsesResult['usage']>);
  assertEquals(response.usage?.input_tokens, 300);
});

test('leaves an inclusive response alone when no flag claims otherwise', async () => {
  const response = await run(invocation(new Set()), inclusiveUsage());
  assertEquals(response.usage?.input_tokens, 1000);
});

test('raises when the flag claims exclusive and the totals say inclusive', async () => {
  await expect(run(invocation(), inclusiveUsage())).rejects.toThrowError(/usage-exclusive-cached-tokens is enabled/);
});

test('raises naming the flag when the cache counts underflow with no verdict', async () => {
  await expect(run(invocation(new Set()), exclusiveUsageWithoutTotal()))
    .rejects.toThrowError(/enable usage-exclusive-cached-tokens/);
});

test('stands down entirely when the wire it speaks about is elsewhere', async () => {
  const response = await run(invocation(undefined, 'chat-completions'), exclusiveUsageWithoutTotal());
  assertEquals(response.usage?.input_tokens, 479);
});
