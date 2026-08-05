import { expect, test } from 'vitest';

import { wrapGeminiAffinityEgress } from '../../../../../src/data-plane/chat/gemini/affinity/egress.ts';
import { analyzeGeminiAffinity } from '../../../../../src/data-plane/chat/gemini/affinity/ingress.ts';
import { AffinityCodec, type AffinityTarget } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { acceptedAffinityEvaluation } from '../../shared/affinity/helpers.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { reassembleGeminiEvents, type GeminiContent, type GeminiStreamEvent } from '@floway-dev/protocols/gemini';
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

const frames = async function* (values: ProtocolFrame<GeminiStreamEvent>[]) {
  yield* values;
};

// The client's next turn replays the model content it reassembled from the
// stream, so reassembly is what carries egress output back to ingress.
const modelContents = async (
  source: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>,
): Promise<GeminiContent[]> => {
  const events = async function* () {
    for await (const frame of source) if (frame.type === 'event') yield frame.event;
  };
  const result = await reassembleGeminiEvents(events());
  if (result.candidates === undefined) throw new Error('Expected reassembled Gemini candidates');
  return result.candidates.map(reassembled => reassembled.content);
};

test('a carrier a real codec emits on thoughtSignature decodes on the next turn', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const contents = await modelContents(wrapGeminiAffinityEgress(frames([
    eventFrame({
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ text: 'visible', thoughtSignature: 'upstream-signature' }] },
        finishReason: 'STOP',
      }],
    }),
  ]), { codec, affinity: targetFor(candidateA) }));

  const prepared = await analyzeGeminiAffinity({ contents }, codec);

  const projectionA = acceptedAffinityEvaluation(prepared, candidateA);
  const projectionB = acceptedAffinityEvaluation(prepared, candidateB);
  expect(projectionA.degrades).toBe(false);
  expect(projectionB.degrades).toBe(true);
  expect(projectionA.materialize().contents?.[0].parts).toEqual([
    { text: 'visible', thoughtSignature: 'upstream-signature' },
  ]);
  expect(projectionB.materialize().contents?.[0].parts).toEqual([{ text: 'visible' }]);
});

test('a synthetic carrier issued for a candidate without a signature decodes on the next turn', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const contents = await modelContents(wrapGeminiAffinityEgress(frames([
    eventFrame({
      candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'visible' }] }, finishReason: 'STOP' }],
    }),
  ]), { codec, affinity: targetFor(candidateA) }));

  const prepared = await analyzeGeminiAffinity({ contents }, codec);

  const projectionA = acceptedAffinityEvaluation(prepared, candidateA);
  const projectionB = acceptedAffinityEvaluation(prepared, candidateB);
  expect(projectionA.degrades).toBe(false);
  expect(projectionB.degrades).toBe(false);
  expect(projectionA.materialize().contents?.[0].parts).toEqual([{ text: 'visible' }]);
  expect(projectionB.materialize().contents?.[0].parts).toEqual([{ text: 'visible' }]);
});
