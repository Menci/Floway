import { test } from 'vitest';

import { withUsageNormalized } from '../../../../../src/data-plane/chat/openai-chat-completions/interceptors/normalize-usage.ts';
import type { OpenAIChatCompletionsInvocation } from '../../../../../src/data-plane/chat/openai-chat-completions/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsUsageEx, OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { type ExecuteResult, eventResult } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx = mockChatGatewayCtx();

const invocation = (payload: OpenAIChatCompletionsPayload = { model: 'test-model', messages: [] }): OpenAIChatCompletionsInvocation => ({
  payload,
  candidate: stubModelCandidate(),
  targetApi: 'openaiChatCompletions',
  headers: new Headers(),
});

const collectFrames = async (result: ExecuteResult<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>): Promise<ProtocolFrame<OpenAIChatCompletionsStreamEvent>[]> => {
  if (result.type !== 'events') throw new Error('expected events result');
  const out: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[] = [];
  for await (const frame of result.events) out.push(frame);
  return out;
};

const runWithFrames = async (...frames: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[]): Promise<ProtocolFrame<OpenAIChatCompletionsStreamEvent>[]> => {
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

const usageRecord = (usage: OpenAIChatCompletionsUsageEx): Record<string, unknown> => usage as unknown as Record<string, unknown>;

test('relocates usage from a non-empty choices chunk onto a synthesized carrier', async () => {
  const frames = await runWithFrames(
    eventFrame({
      id: 'chatcmpl_1',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'gpt-test',
      choices: [{  index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 70 },
      } as unknown as OpenAIChatCompletionsStreamEvent['usage'],
    }),
  );

  assertEquals(frames.length, 2);

  const first = frames[0];
  if (first.type !== 'event') throw new Error('expected event frame');
  assertEquals(first.event.choices, [{  index: 0, delta: {}, finish_reason: 'stop' }]);
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
