import { expect, test } from 'vitest';

import type { OpenAIChatCompletionsInvocation } from '../../../../../src/data-plane/chat/openai-chat-completions/interceptors/types.ts';
import { withVendorKimiOpenAIChatCompletionsNormalize } from '../../../../../src/data-plane/chat/openai-chat-completions/interceptors/vendor-kimi-normalize.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { type ExecuteResult, eventResult, type FlagId } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx = mockChatGatewayCtx();

const invocation = (payload: OpenAIChatCompletionsPayload, enabledFlags: ReadonlySet<FlagId> = new Set(['vendor-kimi'])): OpenAIChatCompletionsInvocation => ({
  payload,
  candidate: stubModelCandidate({ enabledFlags }),
  targetApi: 'openai-chat-completions',
  headers: new Headers(),
});

const collectFrames = async (result: ExecuteResult<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>): Promise<ProtocolFrame<OpenAIChatCompletionsStreamEvent>[]> => {
  if (result.type !== 'events') throw new Error('expected events result');
  const out: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
  for await (const frame of result.events) out.push(frame);
  return out;
};

const usageRecord = (usage: NonNullable<OpenAIChatCompletionsStreamEvent['usage']>): Record<string, unknown> => usage as unknown as Record<string, unknown>;

const baseRequest = (): OpenAIChatCompletionsPayload => ({ model: 'kimi-k2', messages: [{ role: 'user', content: 'hi' }] });

test('rewrites flat cached_tokens into prompt_tokens_details.cached_tokens', async () => {
  const ctx = invocation(baseRequest());
  const result = await withVendorKimiOpenAIChatCompletionsNormalize(ctx, stubCtx, () =>
    Promise.resolve(eventResult(
      (async function* () {
        yield eventFrame({
          id: 'x',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'kimi-test',
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            cached_tokens: 50,
            prompt_tokens_details: { upstream_metric: 'preserved' },
          } as unknown as OpenAIChatCompletionsStreamEvent['usage'],
        });
      })(),
      testTelemetryModelIdentity,
    )));

  const frames = await collectFrames(result);
  assertEquals(frames.length, 1);
  const frame = frames[0];
  if (frame.type !== 'event') throw new Error('expected event frame');
  const usage = usageRecord(frame.event.usage!);
  assertEquals(usage.prompt_tokens_details, { upstream_metric: 'preserved', cached_tokens: 50 });
  assertEquals('cached_tokens' in usage, false);
});

test('replaces array-shaped prompt_tokens_details without copying array indices', async () => {
  const ctx = invocation(baseRequest());
  const result = await withVendorKimiOpenAIChatCompletionsNormalize(ctx, stubCtx, () =>
    Promise.resolve(eventResult(
      (async function* () {
        yield eventFrame({
          id: 'x',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'kimi-test',
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            cached_tokens: 50,
            prompt_tokens_details: [{ cached_tokens: 1 }],
          } as unknown as OpenAIChatCompletionsStreamEvent['usage'],
        });
      })(),
      testTelemetryModelIdentity,
    )));

  const frames = await collectFrames(result);
  const frame = frames[0];
  if (frame.type !== 'event') throw new Error('expected event frame');
  const usage = usageRecord(frame.event.usage!);
  assertEquals(usage.prompt_tokens_details, { cached_tokens: 50 });
});

test('propagates upstream stream errors unchanged', async () => {
  const failure = new Error('upstream stream failed');
  const result = await withVendorKimiOpenAIChatCompletionsNormalize(invocation(baseRequest()), stubCtx, () =>
    Promise.resolve(eventResult(
      (async function* () {
        throw failure;
      })(),
      testTelemetryModelIdentity,
    )));

  await expect(collectFrames(result)).rejects.toBe(failure);
});

test('early-returns when its flag is not set on the candidate', async () => {
  const ctx = invocation(baseRequest(), new Set());
  const result = await withVendorKimiOpenAIChatCompletionsNormalize(ctx, stubCtx, () =>
    Promise.resolve(eventResult(
      (async function* () {
        yield eventFrame({
          id: 'x',
          object: 'chat.completion.chunk',
          created: 0,
          model: 'kimi-test',
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 20,
            total_tokens: 120,
            cached_tokens: 50,
          } as unknown as OpenAIChatCompletionsStreamEvent['usage'],
        });
      })(),
      testTelemetryModelIdentity,
    )));

  const frames = await collectFrames(result);
  const frame = frames[0];
  if (frame.type !== 'event') throw new Error('expected event frame');
  const usage = usageRecord(frame.event.usage!);
  assertEquals(usage.cached_tokens, 50);
  assertEquals('prompt_tokens_details' in usage, false);
});
