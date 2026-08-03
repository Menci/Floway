import { expect, test } from 'vitest';

import { withExclusiveCachedTokensNormalized } from '../../../../../src/data-plane/chat/chat-completions/interceptors/normalize-exclusive-cached-tokens.ts';
import type { ChatCompletionsInvocation } from '../../../../../src/data-plane/chat/chat-completions/interceptors/types.ts';
import { billableUsageFromChatCompletionsUsage } from '../../../../../src/data-plane/chat/chat-completions/usage.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { type ExecuteResult, eventResult, type FlagId } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx = mockChatGatewayCtx();

const invocation = (
  enabledFlags: ReadonlySet<FlagId> = new Set(['usage-exclusive-cached-tokens']),
  targetApi: ChatCompletionsInvocation['targetApi'] = 'chat-completions',
): ChatCompletionsInvocation => ({
  payload: { model: 'kimi-k3', messages: [{ role: 'user', content: 'hi' }] } satisfies ChatCompletionsPayload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi,
  headers: new Headers(),
});

const collectFrames = async (result: ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>): Promise<ProtocolFrame<ChatCompletionsStreamEvent>[]> => {
  if (result.type !== 'events') throw new Error('expected events result');
  const out: ProtocolFrame<ChatCompletionsStreamEvent>[] = [];
  for await (const frame of result.events) out.push(frame);
  return out;
};

const usageChunk = (usage: Record<string, unknown>): ChatCompletionsStreamEvent => ({
  id: 'x',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'kimi-k3',
  choices: [],
  usage: usage as unknown as ChatCompletionsStreamEvent['usage'],
});

const run = async (ctx: ChatCompletionsInvocation, usage: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const result = await withExclusiveCachedTokensNormalized(ctx, stubCtx, () =>
    Promise.resolve(eventResult(
      (async function* () {
        yield eventFrame(usageChunk(usage));
      })(),
      testTelemetryModelIdentity,
    )));
  const frames = await collectFrames(result);
  assertEquals(frames.length, 1);
  const frame = frames[0];
  if (frame.type !== 'event') throw new Error('expected event frame');
  return frame.event.usage as unknown as Record<string, unknown>;
};

// Verbatim from a Charm Hyper kimi-k3 turn: 479 + 13312 + 373 = 14164, so
// `prompt_tokens` counts only what the cache did not serve, and total_tokens
// witnesses it.
const HYPER_USAGE = {
  prompt_tokens: 479,
  completion_tokens: 373,
  total_tokens: 14164,
  prompt_tokens_details: { cached_tokens: 13312 },
};

// The same accounting with the total withheld, which is the only state the
// flag exists to settle.
const HYPER_USAGE_WITHOUT_TOTAL = { ...HYPER_USAGE, total_tokens: undefined };

// An ordinary OpenAI-shaped turn: 1000 + 50 = 1050, cached inside the input.
const INCLUSIVE_USAGE = {
  prompt_tokens: 1000,
  completion_tokens: 50,
  total_tokens: 1050,
  prompt_tokens_details: { cached_tokens: 400 },
};

test('folds on the totals alone, with no flag set', async () => {
  const usage = await run(invocation(new Set()), HYPER_USAGE);
  assertEquals(usage.prompt_tokens, 13791);
  // total_tokens already counted the real input, and now agrees with it.
  assertEquals(usage.total_tokens, 14164);
  assertEquals(usage.prompt_tokens_details, { cached_tokens: 13312 });
});

test('folds on the flag when the totals witness nothing', async () => {
  const usage = await run(invocation(), HYPER_USAGE_WITHOUT_TOTAL);
  assertEquals(usage.prompt_tokens, 13791);
});

test('leaves a normalized chunk billable instead of underflowing', async () => {
  const raw = HYPER_USAGE as unknown as NonNullable<ChatCompletionsStreamEvent['usage']>;
  expect(() => billableUsageFromChatCompletionsUsage(raw, null)).toThrowError(RangeError);

  const usage = await run(invocation(new Set()), HYPER_USAGE);
  assertEquals(
    billableUsageFromChatCompletionsUsage(usage as unknown as NonNullable<ChatCompletionsStreamEvent['usage']>, null),
    { input: 479, cacheRead: 13312, cacheWrite: 0, cacheWrite1h: 0, output: 373 },
  );
});

test('folds cache writes back as well', async () => {
  const usage = await run(invocation(), {
    prompt_tokens: 100,
    completion_tokens: 10,
    prompt_tokens_details: { cached_tokens: 120, cache_creation_input_tokens: 80 },
  });
  assertEquals(usage.prompt_tokens, 300);
});

test('leaves an inclusive chunk alone when no flag claims otherwise', async () => {
  const usage = await run(invocation(new Set()), INCLUSIVE_USAGE);
  assertEquals(usage.prompt_tokens, 1000);
});

test('leaves a chunk with no cache counts untouched', async () => {
  const usage = await run(invocation(), { prompt_tokens: 40, completion_tokens: 1, total_tokens: 41 });
  assertEquals(usage.prompt_tokens, 40);
});

test('raises when the flag claims exclusive and the totals say inclusive', async () => {
  await expect(run(invocation(), INCLUSIVE_USAGE)).rejects.toThrowError(/usage-exclusive-cached-tokens is enabled/);
});

test('raises naming the flag when the cache counts underflow with no verdict', async () => {
  await expect(run(invocation(new Set()), HYPER_USAGE_WITHOUT_TOTAL))
    .rejects.toThrowError(/enable usage-exclusive-cached-tokens/);
});

test('stands down entirely when the wire it speaks about is elsewhere', async () => {
  // A Chat Completions request whose upstream speaks Responses: the Responses
  // entry owns that wire, and by the time these events reach this chain they
  // are a translation. Neither the fold nor its errors apply here, so even a
  // payload that would raise on the wire passes through untouched.
  const usage = await run(invocation(undefined, 'responses'), HYPER_USAGE_WITHOUT_TOTAL);
  assertEquals(usage.prompt_tokens, 479);
});
