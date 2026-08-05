import { expect, test } from 'vitest';

import { wrapChatCompletionsAffinityEgress } from '../../../../../src/data-plane/chat/chat-completions/affinity/egress.ts';
import { analyzeChatCompletionsAffinity } from '../../../../../src/data-plane/chat/chat-completions/affinity/ingress.ts';
import { AffinityCodec, type AffinityTarget } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { acceptedAffinityEvaluation } from '../../shared/affinity/helpers.ts';
import { reassembleChatCompletionsEvents, type ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ModelCandidate } from '@floway-dev/provider';
import { stubModelCandidate } from '@floway-dev/test-utils';

const codec = new AffinityCodec('22'.repeat(32));

const candidate = (upstream: string): ModelCandidate => {
  const base = stubModelCandidate();
  return stubModelCandidate({
    provider: { ...base.provider, upstreamId: upstream },
    model: { id: 'model' },
  });
};

const targetFor = (value: ModelCandidate): AffinityTarget => ({
  upstreamId: value.provider.upstreamId,
  modelId: value.model.id,
  ...(value.rules !== undefined ? { rules: value.rules } : {}),
});

const chunk = (choices: ChatCompletionsStreamEvent['choices']): ChatCompletionsStreamEvent => ({
  id: 'chatcmpl_1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'model',
  choices,
});

const frames = async function* (values: ProtocolFrame<ChatCompletionsStreamEvent>[]) {
  yield* values;
};

// The client's next turn replays the assistant message it reassembled from the
// stream, so reassembly is what carries egress output back to ingress.
const assistantMessage = async (source: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>) => {
  const events = async function* () {
    for await (const frame of source) if (frame.type === 'event') yield frame.event;
  };
  return (await reassembleChatCompletionsEvents(events())).choices[0].message;
};

test('a carrier a real codec emits on reasoning_opaque decodes on the next turn', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const message = await assistantMessage(wrapChatCompletionsAffinityEgress(frames([
    eventFrame(chunk([{
      index: 0,
      delta: { content: 'answer', reasoning_opaque: 'upstream-opaque' },
      finish_reason: 'stop',
    }])),
    doneFrame(),
  ]), { codec, affinity: targetFor(candidateA) }));

  const prepared = await analyzeChatCompletionsAffinity({ model: 'model', messages: [message] }, codec);

  const projectionA = acceptedAffinityEvaluation(prepared, candidateA);
  const projectionB = acceptedAffinityEvaluation(prepared, candidateB);
  expect(projectionA.degrades).toBe(false);
  expect(projectionB.degrades).toBe(true);
  expect(projectionA.materialize().messages[0]).toMatchObject({
    content: 'answer',
    reasoning_opaque: 'upstream-opaque',
  });
  expect(projectionB.materialize().messages[0]).not.toHaveProperty('reasoning_opaque');
});

test('a synthetic carrier issued for a choice without reasoning decodes on the next turn', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const message = await assistantMessage(wrapChatCompletionsAffinityEgress(frames([
    eventFrame(chunk([{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }])),
    doneFrame(),
  ]), { codec, affinity: targetFor(candidateA) }));

  const prepared = await analyzeChatCompletionsAffinity({ model: 'model', messages: [message] }, codec);

  const projectionA = acceptedAffinityEvaluation(prepared, candidateA);
  const projectionB = acceptedAffinityEvaluation(prepared, candidateB);
  expect(projectionA.degrades).toBe(false);
  expect(projectionB.degrades).toBe(false);
  expect(projectionA.materialize().messages[0]).not.toHaveProperty('reasoning_opaque');
  expect(projectionB.materialize().messages[0]).not.toHaveProperty('reasoning_opaque');
});
