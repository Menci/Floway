import { expect, test } from 'vitest';

import { wrapOpenAIChatCompletionsAffinityEgress } from '../../../../../src/data-plane/chat/openai-chat-completions/affinity/egress.ts';
import { analyzeOpenAIChatCompletionsAffinity } from '../../../../../src/data-plane/chat/openai-chat-completions/affinity/ingress.ts';
import { AffinityCodec, type AffinityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { acceptedAffinityEvaluation } from '../../shared/affinity/helpers.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { type OpenAIChatCompletionsAssistantDeltaEx, type OpenAIChatCompletionsAssistantMessageEx, reassembleOpenAIChatCompletionsEvents, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
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

const targetFor = (value: ModelCandidate): AffinityIdentity => ({
  upstreamId: value.provider.upstreamId,
  modelId: value.model.id,
  ...(value.rules !== undefined ? { rules: value.rules } : {}),
  opaqueBlobCompatibilityIdentity: { upstreamId: value.provider.upstreamId, key: value.model.id },
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

test('unwraps encrypted reasoning details for matching affinity while preserving other details', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const detail = { type: 'reasoning.encrypted', data: 'upstream-encrypted-data', format: 'native-format' };
  const wrappedDetail = {
    ...detail,
    data: await codec.wrap(detail.data, targetFor(candidateA), 'openai-chat-completions.reasoning_details.reasoning.encrypted.data'),
  };
  const textDetail = { type: 'reasoning.text', text: 'thinking' };
  const message: OpenAIChatCompletionsAssistantMessageEx = {
    role: 'assistant', content: 'answer', reasoning_details: [textDetail, wrappedDetail],
  };
  const prepared = await analyzeOpenAIChatCompletionsAffinity({ model: 'model', messages: [message] }, codec);

  const projectionA = acceptedAffinityEvaluation(prepared, candidateA);
  expect(projectionA.preferred).toBe(true);
  expect(projectionA.degrades).toBe(false);
  expect(projectionA.materialize().messages[0]).toEqual({ ...message, reasoning_details: [textDetail, detail] });

  const projectionB = acceptedAffinityEvaluation(prepared, candidateB);
  expect(projectionB.preferred).toBe(false);
  expect(projectionB.degrades).toBe(true);
  expect(projectionB.materialize().messages[0]).toEqual({ ...message, reasoning_details: [textDetail] });
  expect(message.reasoning_details).toEqual([textDetail, wrappedDetail]);
});

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

test('a synthetic carrier issued for a choice without reasoning decodes on the next turn', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const message = await assistantMessage(wrapOpenAIChatCompletionsAffinityEgress(frames([
    eventFrame(chunk([{  index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }])),
    doneFrame(),
  ]), { codec, affinity: targetFor(candidateA) }));

  const prepared = await analyzeOpenAIChatCompletionsAffinity({ model: 'model', messages: [message] }, codec);

  const projectionA = acceptedAffinityEvaluation(prepared, candidateA);
  const projectionB = acceptedAffinityEvaluation(prepared, candidateB);
  expect(projectionA.degrades).toBe(false);
  expect(projectionB.degrades).toBe(false);
  expect(projectionA.materialize().messages[0]).not.toHaveProperty('reasoning_opaque');
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
  expect(projectionA.materialize().messages[0]).not.toHaveProperty('reasoning_opaque');
  expect(projectionB.materialize().messages[0]).not.toHaveProperty('reasoning_opaque');
});
