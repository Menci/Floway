import { expect, test } from 'vitest';

import { wrapAnthropicMessagesAffinityEgress } from '../../../../../src/data-plane/chat/anthropic-messages/affinity/egress.ts';
import { analyzeAnthropicMessagesAffinity } from '../../../../../src/data-plane/chat/anthropic-messages/affinity/ingress.ts';
import type { RouteAffinityRequestAnalysis, CandidateAffinityEvaluation } from '../../../../../src/data-plane/chat/pipeline/index.ts';
import { AffinityCodec, type AffinityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { stubRouteCandidate } from '../../../../test-utils/chat-pipeline.ts';
import { createAnthropicMessagesUsage, reassembleAnthropicMessagesEvents, type AnthropicMessagesAssistantContentBlock, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { RouteCandidate } from '@floway-dev/provider';

const codec = new AffinityCodec('22'.repeat(32));

const candidate = (upstream: string): RouteCandidate => stubRouteCandidate({ upstreamId: upstream, modelId: 'model' });

const targetFor = (value: RouteCandidate): AffinityIdentity => ({
  upstreamId: value.upstreamId,
  modelId: value.modelId,
  ...(value.rules !== undefined ? { rules: value.rules } : {}),
  opaqueBlobCompatibilityIdentity: { upstreamId: value.upstreamId, key: value.upstreamModelId },
});

const acceptedAffinityEvaluation = <T>(
  analysis: RouteAffinityRequestAnalysis<T>,
  value: RouteCandidate,
): Extract<CandidateAffinityEvaluation<T>, { kind: 'accepted' }> => {
  const evaluation = analysis.evaluateCandidate(value);
  if (evaluation.kind === 'rejected') throw new Error('Expected accepted affinity candidate');
  return evaluation;
};

const frames = async function* (values: ProtocolFrame<AnthropicMessagesStreamEventEx>[]) {
  yield* values;
};

// The client's next turn replays the assistant blocks it reassembled from the
// stream, so reassembly is what carries egress output back to ingress.
const assistantContent = async (
  source: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>>,
): Promise<AnthropicMessagesAssistantContentBlock[]> => {
  const events = async function* (): AsyncGenerator<AnthropicMessagesStreamEventEx> {
    yield { type: 'message_start', message: { id: 'msg_roundtrip', type: 'message', role: 'assistant', model: 'model', content: [], stop_reason: null, stop_details: null, stop_sequence: null, container: null, diagnostics: null, usage: createAnthropicMessagesUsage(0, 0) } };
    for await (const frame of source) if (frame.type === 'event') yield frame.event;
  };
  return (await reassembleAnthropicMessagesEvents(events())).content;
};

test('carriers a real codec emits on both Anthropic Messages slots decode on the next turn', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const content = await assistantContent(wrapAnthropicMessagesAffinityEgress(frames([
    eventFrame({ type: 'content_block_start', index: 0, content_block: { signature: '', type: 'thinking', thinking: '' } }),
    eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'visible' } }),
    eventFrame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'upstream-signature' } }),
    eventFrame({ type: 'content_block_stop', index: 0 }),
    eventFrame({ type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'upstream-redacted' } }),
    eventFrame({ type: 'content_block_stop', index: 1 }),
    eventFrame({ usage: { input_tokens: null, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null }, type: 'message_delta', delta: { container: null, stop_details: null, stop_sequence: null, stop_reason: 'end_turn' } }),
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
  expect(projectionB.materialize().messages).toEqual([]);
});

test.each([
  { name: 'empty initial signature', fields: { signature: '' }, deltas: [] },
  { name: 'missing signature', fields: {}, deltas: [] },
  { name: 'latest signature delta', fields: { signature: 'initial' }, deltas: ['first', 'latest'] },
])('round-trips $name in first and subsequent thinking blocks', async ({ fields, deltas }) => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  // Non-string values exercise wire fidelity beyond the SDK's signature type.
  const block = { type: 'thinking', thinking: 'visible', ...fields } as Extract<AnthropicMessagesAssistantContentBlock, { type: 'thinking' }>;
  const original = deltas.length === 0 ? block : { ...block, signature: deltas.at(-1) };

  for (const index of [0, 1]) {
    const source: ProtocolFrame<AnthropicMessagesStreamEventEx>[] = [];
    if (index === 1) source.push(
      eventFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'answer', citations: null } }),
      eventFrame({ type: 'content_block_stop', index: 0 }),
    );
    source.push(
      eventFrame({ type: 'content_block_start', index, content_block: block }),
      ...deltas.map(signature => eventFrame<AnthropicMessagesStreamEventEx>({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } })),
      eventFrame({ type: 'content_block_stop', index }),
      eventFrame({ type: 'message_stop' }),
    );
    const content = await assistantContent(wrapAnthropicMessagesAffinityEgress(frames(source), { codec, affinity: targetFor(candidateA) }));
    const prepared = await analyzeAnthropicMessagesAffinity({
      model: 'model',
      max_tokens: 100,
      messages: [{ role: 'assistant', content }],
    }, codec);
    const sameCandidate = acceptedAffinityEvaluation(prepared, candidateA);
    expect(sameCandidate.degrades).toBe(false);
    const restored = sameCandidate.materialize().messages[0].content;
    expect(Array.isArray(restored) && restored.find(part => part.type === 'thinking')).toStrictEqual(original);

    const otherCandidate = acceptedAffinityEvaluation(prepared, candidateB);
    const hasSignature = typeof original.signature === 'string';
    expect(otherCandidate.degrades).toBe(hasSignature);
    const remaining = otherCandidate.materialize().messages.flatMap(message => typeof message.content === 'string' ? [] : message.content);
    expect(remaining.find(part => part.type === 'thinking')).toStrictEqual(hasSignature ? undefined : original);
  }
});
