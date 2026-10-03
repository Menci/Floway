import { expect, test } from 'vitest';

import { wrapOpenAIChatCompletionsAffinityEgress } from '../../../../../src/data-plane/chat/openai-chat-completions/affinity/egress.ts';
import { analyzeOpenAIChatCompletionsAffinity } from '../../../../../src/data-plane/chat/openai-chat-completions/affinity/ingress.ts';
import { wrapChatCompletionsReasoningAffinity, reasoningAffinitySlots } from '../../../../../src/data-plane/chat/openai-chat-completions/affinity/reasoning.ts';
import { AffinityCodec, type AffinityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { acceptedAffinityEvaluation } from '../../shared/affinity/helpers.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { reassembleOpenAIChatCompletionsEvents, type OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
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

const chunk = (choices: OpenAIChatCompletionsStreamEvent['choices']): OpenAIChatCompletionsStreamEvent => ({
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

test('a synthetic carrier issued for a choice without reasoning decodes on the next turn', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const message = await assistantMessage(wrapOpenAIChatCompletionsAffinityEgress(frames([
    eventFrame(chunk([{ index: 0, delta: { content: 'answer' }, finish_reason: 'stop' }])),
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

test.each(['openrouter-reasoning-details', 'litellm-thinking-blocks'] as const)('wraps every opaque member and removes a synthetic %s member on replay', async format => {
  const candidateA = candidate('upstream-a');
  const original = format === 'openrouter-reasoning-details'
    ? { role: 'assistant' as const, content: 'answer', reasoning_details: [{ type: 'reasoning.text', text: 'thinking', signature: 'signature', id: 'text' }, { type: 'reasoning.encrypted', data: 'opaque', id: 'encrypted', format: 'unknown' }] }
    : { role: 'assistant' as const, content: 'answer', thinking_blocks: [{ type: 'thinking', thinking: 'thinking', signature: 'signature' }, { type: 'redacted_thinking', data: 'opaque' }] };
  const wrapped = await wrapChatCompletionsReasoningAffinity(original, { codec, affinity: targetFor(candidateA) }, format);
  const slots = reasoningAffinitySlots(wrapped);
  expect(slots).toHaveLength(2);
  expect(slots.map(slot => slot.value)).not.toEqual(['signature', 'opaque']);
  const analysis = await analyzeOpenAIChatCompletionsAffinity({ model: 'model', messages: [wrapped] }, codec);
  expect(acceptedAffinityEvaluation(analysis, candidateA).materialize().messages[0]).toEqual(original);
  const synthetic = await wrapChatCompletionsReasoningAffinity({ role: 'assistant' as const, content: 'answer' }, { codec, affinity: targetFor(candidateA) }, format);
  const next = await analyzeOpenAIChatCompletionsAffinity({ model: 'model', messages: [synthetic] }, codec);
  const restored = acceptedAffinityEvaluation(next, candidateA).materialize().messages[0];
  expect(reasoningAffinitySlots(restored)).toEqual([]);
  expect(restored.content).toBe('answer');
});

test('streams readable OpenRouter details and attaches the carrier to their final signature', async () => {
  const candidateA = candidate('upstream-a');
  const source = wrapOpenAIChatCompletionsAffinityEgress(frames([
    eventFrame(chunk([{ index: 0, delta: { reasoning_details: [{ type: 'reasoning.text', id: 'r', index: 0, text: 'First' }] }, finish_reason: null }])),
    eventFrame(chunk([{ index: 0, delta: { reasoning_details: [{ type: 'reasoning.text', index: 0, signature: 'signature' }] }, finish_reason: 'stop' }])),
    doneFrame(),
  ]), { codec, affinity: targetFor(candidateA) }, 'openrouter-reasoning-details');
  const chunks = [];
  for await (const frame of source) if (frame.type === 'event') chunks.push(frame.event);
  expect(chunks[0].choices[0].delta.reasoning_details?.[0].text).toBe('First');
  const signed = chunks.flatMap(event => event.choices.flatMap(choice => reasoningAffinitySlots(choice.delta)));
  expect(signed).toHaveLength(1);
  expect(await codec.unwrap(signed[0].value, signed[0].domain)).toMatchObject({ kind: 'owned', value: 'signature' });
});
