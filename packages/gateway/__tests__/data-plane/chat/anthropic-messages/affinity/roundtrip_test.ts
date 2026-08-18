import { expect, test } from 'vitest';

import { wrapAnthropicMessagesAffinityEgress } from '../../../../../src/data-plane/chat/anthropic-messages/affinity/egress.ts';
import { analyzeAnthropicMessagesAffinity } from '../../../../../src/data-plane/chat/anthropic-messages/affinity/ingress.ts';
import { AffinityCodec, type AffinityTarget } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { acceptedAffinityEvaluation } from '../../shared/affinity/helpers.ts';
import { reassembleAnthropicMessagesEvents, type AnthropicMessagesAssistantContentBlock, type AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
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

const frames = async function* (values: ProtocolFrame<AnthropicMessagesStreamEvent>[]) {
  yield* values;
};

// The client's next turn replays the assistant blocks it reassembled from the
// stream, so reassembly is what carries egress output back to ingress.
const assistantContent = async (
  source: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEvent>>,
): Promise<AnthropicMessagesAssistantContentBlock[]> => {
  const events = async function* () {
    for await (const frame of source) if (frame.type === 'event') yield frame.event;
  };
  return (await reassembleAnthropicMessagesEvents(events())).content;
};

test('carriers a real codec emits on both Anthropic Messages slots decode on the next turn', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const content = await assistantContent(wrapAnthropicMessagesAffinityEgress(frames([
    eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'visible' } }),
    eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'upstream-signature' } }),
    eventFrame({ type: 'content_block_stop', index: 0 }),
    eventFrame({ type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'upstream-redacted' } }),
    eventFrame({ type: 'content_block_stop', index: 1 }),
    eventFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    eventFrame({ type: 'message_stop' }),
  ]), { codec, affinity: targetFor(candidateA) }));

  const prepared = await analyzeAnthropicMessagesAffinity({
    model: 'model',
    max_tokens: 100,
    messages: [{ role: 'assistant', content }],
  }, codec);

  const projectionA = acceptedAffinityEvaluation(prepared, candidateA);
  const projectionB = acceptedAffinityEvaluation(prepared, candidateB);
  expect(projectionA.degrades).toBe(false);
  expect(projectionB.degrades).toBe(true);
  expect(projectionA.materialize().messages[0].content).toEqual([
    { type: 'thinking', thinking: 'visible', signature: 'upstream-signature' },
    { type: 'redacted_thinking', data: 'upstream-redacted' },
  ]);
  expect(projectionB.materialize().messages[0].content).toEqual([
    { type: 'thinking', thinking: 'visible' },
  ]);
});

test('a synthetic carrier issued for a turn without thinking decodes on the next turn', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const content = await assistantContent(wrapAnthropicMessagesAffinityEgress(frames([
    eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } }),
    eventFrame({ type: 'content_block_stop', index: 0 }),
    eventFrame({ type: 'message_stop' }),
  ]), { codec, affinity: targetFor(candidateA) }));

  const prepared = await analyzeAnthropicMessagesAffinity({
    model: 'model',
    max_tokens: 100,
    messages: [{ role: 'assistant', content }],
  }, codec);

  const projectionA = acceptedAffinityEvaluation(prepared, candidateA);
  const projectionB = acceptedAffinityEvaluation(prepared, candidateB);
  expect(projectionA.degrades).toBe(false);
  expect(projectionB.degrades).toBe(false);
  expect(projectionA.materialize().messages[0].content).toEqual([{ type: 'text', text: 'answer' }]);
  expect(projectionB.materialize().messages[0].content).toEqual([{ type: 'text', text: 'answer' }]);
});
