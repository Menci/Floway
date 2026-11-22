import { expect, test } from 'vitest';

import { wrapOpenAIChatCompletionsAffinityEgress } from '../../../../../src/data-plane/chat/openai-chat-completions/affinity/egress.ts';
import { analyzeOpenAIChatCompletionsAffinity } from '../../../../../src/data-plane/chat/openai-chat-completions/affinity/ingress.ts';
import { AffinityCodec, type AffinityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { stubRouteCandidate } from '../../../../test-utils/chat-pipeline.ts';
import { acceptedAffinityEvaluation } from '../../shared/affinity/helpers.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { type OpenAIChatCompletionsAssistantDeltaEx, reassembleOpenAIChatCompletionsEvents, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { RouteCandidate } from '@floway-dev/provider';

const codec = new AffinityCodec('22'.repeat(32));

const candidate = (upstream: string): RouteCandidate => stubRouteCandidate({ upstreamId: upstream, modelId: 'model' });

const targetFor = (value: RouteCandidate): AffinityIdentity => ({
  upstreamId: value.upstreamId,
  modelId: value.modelId,
  ...(value.rules !== undefined ? { rules: value.rules } : {}),
  opaqueBlobCompatibilityIdentity: { upstreamId: value.upstreamId, key: value.modelId },
});

const chunk = (choices: Array<Omit<OpenAIChatCompletionsStreamEvent['choices'][number], 'delta'> & { delta: OpenAIChatCompletionsAssistantDeltaEx }>): OpenAIChatCompletionsStreamEvent => ({
  id: 'chatcmpl_1',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'model',
  choices,
});

const frames = async function* (values: ProtocolFrame<OpenAIChatCompletionsStreamEvent>[]) {
  yield* values;
};

// The client's next turn replays the assistant message it reassembled from the
// stream, so reassembly is what carries egress output back to ingress.
const assistantMessage = async (source: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>) => {
  const events = async function* () {
    for await (const frame of source) if (frame.type === 'event') yield frame.event;
  };
  return (await reassembleOpenAIChatCompletionsEvents(events())).choices[0].message;
};

test('a carrier a real codec emits on reasoning_opaque decodes on the next turn', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const message = await assistantMessage(wrapOpenAIChatCompletionsAffinityEgress(frames([
    eventFrame(chunk([{

      index: 0,
      delta: { content: 'answer', reasoning_opaque: 'upstream-opaque' },
      finish_reason: 'stop',
    }])),
    doneFrame(),
  ]), { codec, affinity: targetFor(candidateA) }));

  const prepared = await analyzeOpenAIChatCompletionsAffinity({ model: 'model', messages: [message] }, codec);

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

test('encrypted reasoning detail data follows affinity without changing the opaque state machine', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const message = await assistantMessage(wrapOpenAIChatCompletionsAffinityEgress(frames([
    eventFrame(chunk([{
      index: 0,
      delta: {
        content: 'answer',
        reasoning_details: [
          { type: 'reasoning.summary', summary: 'visible' },
          { type: 'reasoning.encrypted', data: 'upstream-encrypted', vendor: 'kept' },
        ],
      },
      finish_reason: 'stop',
    }])),
    doneFrame(),
  ]), { codec, affinity: targetFor(candidateA) }));

  const prepared = await analyzeOpenAIChatCompletionsAffinity({ model: 'model', messages: [message] }, codec);
  const projectionA = acceptedAffinityEvaluation(prepared, candidateA);
  const projectionB = acceptedAffinityEvaluation(prepared, candidateB);

  expect(projectionA.degrades).toBe(false);
  expect(projectionA.materialize().messages[0]).toMatchObject({
    reasoning_details: [
      { type: 'reasoning.summary', summary: 'visible' },
      { type: 'reasoning.encrypted', data: 'upstream-encrypted', vendor: 'kept' },
    ],
  });
  expect(projectionB.degrades).toBe(true);
  expect(projectionB.materialize().messages[0]).toMatchObject({
    reasoning_details: [{ type: 'reasoning.summary', summary: 'visible' }],
  });
  // Egress minted a synthetic reasoning_opaque carrier; ingress removes it for every candidate.
  expect(projectionA.materialize().messages[0]).not.toHaveProperty('reasoning_opaque');
  expect(projectionB.materialize().messages[0]).not.toHaveProperty('reasoning_opaque');
});
