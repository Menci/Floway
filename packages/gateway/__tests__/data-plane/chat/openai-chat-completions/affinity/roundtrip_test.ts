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

test('a carrier a real codec emits on reasoning_opaque decodes on the next turn', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const message = await assistantMessage(wrapOpenAIChatCompletionsAffinityEgress(frames([
    eventFrame(chunk([{

      index: 0,
      delta: { content: 'answer', reasoning_text: 'visible reasoning', reasoning_opaque: 'upstream-opaque' },
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
    reasoning_text: 'visible reasoning',
    reasoning_opaque: 'upstream-opaque',
  });
  expect(projectionB.materialize().messages[0]).toEqual({ role: 'assistant', content: 'answer', refusal: null });
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
  expect(projectionB.materialize().messages[0]).toEqual({ role: 'assistant', content: 'answer', refusal: null });
  // Egress minted a synthetic reasoning_opaque carrier; ingress removes it for every candidate.
  expect(projectionA.materialize().messages[0]).not.toHaveProperty('reasoning_opaque');
});

test('strips reasoning extensions from a turn with only a routing carrier', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const carrier = await codec.wrap(undefined, targetFor(candidateA), 'openai-chat-completions.reasoning_opaque');
  const message = {
    role: 'assistant' as const,
    content: 'answer',
    tool_calls: [{ type: 'function' as const, id: 'call_1', function: { name: 'lookup', arguments: '{}' } }],
  };
  const reasoning = {
    reasoning_text: 'reasoning text',
    reasoning_content: 'reasoning content',
    reasoning: 'reasoning',
    reasoning_details: [{ type: 'reasoning.summary', summary: 'visible' }],
    reasoning_items: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'visible' }] }],
    thinking_blocks: [{ type: 'thinking', thinking: 'visible', signature: 'signature' }],
  };
  const messages: OpenAIChatCompletionsAssistantMessageEx[] = [
    { ...message, ...reasoning, reasoning_opaque: carrier },
    { ...message, reasoning_opaque: carrier },
  ];
  const prepared = await analyzeOpenAIChatCompletionsAffinity({ model: 'model', messages }, codec);

  const compatible = acceptedAffinityEvaluation(prepared, candidateA);
  const incompatible = acceptedAffinityEvaluation(prepared, candidateB);
  expect(compatible.degrades).toBe(false);
  expect(compatible.materialize().messages).toEqual([{ ...message, ...reasoning }, message]);
  expect(incompatible.degrades).toBe(true);
  expect(incompatible.materialize().messages).toEqual([message, message]);

  const ordinaryOnly = await analyzeOpenAIChatCompletionsAffinity({ model: 'model', messages: messages.slice(1) }, codec);
  expect(acceptedAffinityEvaluation(ordinaryOnly, candidateB).degrades).toBe(false);
});
