import { test } from 'vitest';

import { withUsageNormalized } from './normalize-usage.ts';
import { chatCompletionsInvocation, stubRequestContext, testTelemetryModelIdentity } from './test-helpers.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import type { ExecuteResult } from '../../../shared/errors/result.ts';
import { eventResult } from '../../../shared/errors/result.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';

const baseCtx = (payload: ChatCompletionsPayload = { model: 'test-model', messages: [] }): ReturnType<typeof chatCompletionsInvocation> => chatCompletionsInvocation(payload);

const collectFrames = async (result: ExecuteResult<ProtocolFrame<ChatCompletionChunk>>): Promise<ProtocolFrame<ChatCompletionChunk>[]> => {
  if (result.type !== 'events') throw new Error('expected events result');
  const out: ProtocolFrame<ChatCompletionChunk>[] = [];
  for await (const frame of result.events) out.push(frame);
  return out;
};

const runWithFrames = async (...frames: ProtocolFrame<ChatCompletionChunk>[]): Promise<ProtocolFrame<ChatCompletionChunk>[]> => {
  const result = await withUsageNormalized(baseCtx(), stubRequestContext, () =>
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

const usageRecord = (usage: NonNullable<ChatCompletionChunk['usage']>): Record<string, unknown> => usage as unknown as Record<string, unknown>;

test('withUsageNormalized rewrites DeepSeek prompt_cache_hit_tokens on protocol usage carriers', async () => {
  const frames = await runWithFrames(
    eventFrame({
      id: 'x',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'deepseek-test',
      choices: [],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_cache_hit_tokens: 70,
        prompt_cache_miss_tokens: 30,
      } as unknown as ChatCompletionChunk['usage'],
    }),
  );

  assertEquals(frames.length, 1);
  const frame = frames[0];
  if (frame.type !== 'event') throw new Error('expected event frame');
  const usage = usageRecord(frame.event.usage!);
  assertEquals(usage.prompt_tokens, 100);
  assertEquals(usage.prompt_tokens_details, { cached_tokens: 70 });
  assertEquals('prompt_cache_hit_tokens' in usage, false);
  assertEquals('prompt_cache_miss_tokens' in usage, false);
});

test('withUsageNormalized rewrites Kimi flat cached_tokens on protocol usage carriers', async () => {
  const frames = await runWithFrames(
    eventFrame({
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
      } as unknown as ChatCompletionChunk['usage'],
    }),
  );

  const frame = frames[0];
  if (frame.type !== 'event') throw new Error('expected event frame');
  const usage = usageRecord(frame.event.usage!);
  assertEquals(usage.prompt_tokens_details, { cached_tokens: 50 });
  assertEquals('cached_tokens' in usage, false);
});

test('withUsageNormalized leaves standard prompt_tokens_details untouched', async () => {
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
      } as unknown as ChatCompletionChunk['usage'],
    }),
  );

  const frame = frames[0];
  if (frame.type !== 'event') throw new Error('expected event frame');
  const usage = usageRecord(frame.event.usage!);
  assertEquals(usage.prompt_tokens_details, {
    cached_tokens: 60,
    audio_tokens: 0,
  });
});

test('withUsageNormalized relocates usage from a non-empty choices chunk to a synthesized carrier', async () => {
  const frames = await runWithFrames(
    eventFrame({
      id: 'chatcmpl_1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deepseek-test',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_cache_hit_tokens: 70,
        prompt_cache_miss_tokens: 30,
      } as unknown as ChatCompletionChunk['usage'],
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
  assertEquals(carrier.event.model, 'deepseek-test');
  assertEquals(carrier.event.choices, []);
  const usage = usageRecord(carrier.event.usage!);
  assertEquals(usage.prompt_tokens, 100);
  assertEquals(usage.prompt_tokens_details, { cached_tokens: 70 });
  assertEquals('prompt_cache_hit_tokens' in usage, false);
});

test('withUsageNormalized rewrites usage in-place on a spec-compliant carrier chunk', async () => {
  const frames = await runWithFrames(
    eventFrame({
      id: 'chatcmpl_2',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'kimi-test',
      choices: [],
      usage: {
        prompt_tokens: 80,
        completion_tokens: 10,
        total_tokens: 90,
        cached_tokens: 25,
      } as unknown as ChatCompletionChunk['usage'],
    }),
  );

  assertEquals(frames.length, 1);
  const carrier = frames[0];
  if (carrier.type !== 'event') throw new Error('expected event frame');
  assertEquals(carrier.event.choices, []);
  const usage = usageRecord(carrier.event.usage!);
  assertEquals(usage.prompt_tokens_details, { cached_tokens: 25 });
  assertEquals('cached_tokens' in usage, false);
});

test('withUsageNormalized leaves chunks without usage untouched', async () => {
  const original = eventFrame({
    id: 'chatcmpl_3',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        delta: { content: 'hi' },
        finish_reason: null,
      },
    ],
  } satisfies ChatCompletionChunk);

  const frames = await runWithFrames(original);

  assertEquals(frames, [original]);
});

test('withUsageNormalized passes protocol done frames through verbatim', async () => {
  const done = doneFrame();

  const frames = await runWithFrames(done);

  assertEquals(frames, [done]);
});
