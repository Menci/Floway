import { test } from 'vitest';

import { withUsageNormalized } from './normalize-usage.ts';
import type { ChatCompletionsInvocation } from './types.ts';
import { createNonResponsesSourceStore } from '../../responses/items/store.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { type ExecuteResult, eventResult } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx: ChatGatewayCtx = {
  apiKeyId: 'test-key',
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  responseHeaders: new Headers(),
  backgroundScheduler: () => {},
  requestStartedAt: 0,
  store: createNonResponsesSourceStore('test-key'),
};

const invocation = (payload: ChatCompletionsPayload = { model: 'test-model', messages: [] }): ChatCompletionsInvocation => ({
  payload,
  candidate: stubModelCandidate(),
  targetApi: 'chat-completions',
  headers: new Headers(),
});

const collectFrames = async (result: ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>): Promise<ProtocolFrame<ChatCompletionsStreamEvent>[]> => {
  if (result.type !== 'events') throw new Error('expected events result');
  const out: ProtocolFrame<ChatCompletionsStreamEvent>[] = [];
  for await (const frame of result.events) out.push(frame);
  return out;
};

const runWithFrames = async (...frames: ProtocolFrame<ChatCompletionsStreamEvent>[]): Promise<ProtocolFrame<ChatCompletionsStreamEvent>[]> => {
  const result = await withUsageNormalized(invocation(), stubCtx, () =>
    Promise.resolve(
      eventResult(
        (async function* () {
          for (const frame of frames) yield frame;
        })(),
        testTelemetryModelIdentity,
      ),
    ));
  return await collectFrames(result);
};

const usageRecord = (usage: NonNullable<ChatCompletionsStreamEvent['usage']>): Record<string, unknown> => usage as unknown as Record<string, unknown>;

test('leaves a spec-compliant carrier usage chunk untouched', async () => {
  const frames = await runWithFrames(
    eventFrame({
      id: 'x',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'gpt-test',
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 60, audio_tokens: 0 },
      } as unknown as ChatCompletionsStreamEvent['usage'],
    }),
  );

  assertEquals(frames.length, 1);
  const frame = frames[0];
  if (frame.type !== 'event') throw new Error('expected event frame');
  const usage = usageRecord(frame.event.usage!);
  assertEquals(usage.prompt_tokens_details, { cached_tokens: 60, audio_tokens: 0 });
});

test('relocates usage from a non-empty choices chunk onto a synthesized carrier', async () => {
  const frames = await runWithFrames(
    eventFrame({
      id: 'chatcmpl_1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-test',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 70 },
      } as unknown as ChatCompletionsStreamEvent['usage'],
    }),
  );

  assertEquals(frames.length, 2);

  const first = frames[0];
  if (first.type !== 'event') throw new Error('expected event frame');
  assertEquals(first.event.choices, [{ index: 0, delta: {}, finish_reason: 'stop' }]);
  assertEquals(first.event.usage, undefined);

  const carrier = frames[1];
  if (carrier.type !== 'event') throw new Error('expected event frame');
  assertEquals(carrier.event.id, 'chatcmpl_1');
  assertEquals(carrier.event.model, 'gpt-test');
  assertEquals(carrier.event.choices, []);
  const usage = usageRecord(carrier.event.usage!);
  assertEquals(usage.prompt_tokens, 100);
  assertEquals(usage.prompt_tokens_details, { cached_tokens: 70 });
});

test('passes raw vendor cache fields through unchanged so vendor interceptors stay responsible for the rewrite', async () => {
  const frames = await runWithFrames(
    eventFrame({
      id: 'x',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'unknown-vendor',
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_cache_hit_tokens: 70,
        cached_tokens: 25,
      } as unknown as ChatCompletionsStreamEvent['usage'],
    }),
  );

  assertEquals(frames.length, 1);
  const frame = frames[0];
  if (frame.type !== 'event') throw new Error('expected event frame');
  const usage = usageRecord(frame.event.usage!);
  assertEquals(usage.prompt_cache_hit_tokens, 70);
  assertEquals(usage.cached_tokens, 25);
  assertEquals('prompt_tokens_details' in usage, false);
});

test('leaves chunks without usage untouched', async () => {
  const original = eventFrame({
    id: 'chatcmpl_3',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-test',
    choices: [
      { index: 0, delta: { content: 'hi' }, finish_reason: null },
    ],
  } satisfies ChatCompletionsStreamEvent);

  const frames = await runWithFrames(original);

  assertEquals(frames, [original]);
});

test('passes protocol done frames through verbatim', async () => {
  const done = doneFrame();

  const frames = await runWithFrames(done);

  assertEquals(frames, [done]);
});
