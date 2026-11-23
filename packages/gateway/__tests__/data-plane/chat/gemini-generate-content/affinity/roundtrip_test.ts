import { expect, test } from 'vitest';

import { decodeGeminiGenerateContentAffinity, evaluateGeminiGenerateContentAffinity } from '../../../../../src/data-plane/chat/gemini-generate-content/affinity/analysis.ts';
import { wrapGeminiGenerateContentAffinityEgress } from '../../../../../src/data-plane/chat/gemini-generate-content/affinity/egress.ts';
import { AffinityCodec, type AffinityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { reassembleGeminiGenerateContentEvents, type GeminiGenerateContentContent, type GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
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

const frames = async function* (values: ProtocolFrame<GeminiGenerateContentStreamEvent>[]) {
  yield* values;
};

// The client's next turn replays the model content it reassembled from the
// stream, so reassembly is what carries egress output back to ingress.
const modelContents = async (
  source: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>,
): Promise<GeminiGenerateContentContent[]> => {
  const events = async function* () {
    for await (const frame of source) if (frame.type === 'event') yield frame.event;
  };
  const result = await reassembleGeminiGenerateContentEvents(events());
  if (result.candidates === undefined) throw new Error('Expected reassembled Gemini generateContent candidates');
  return result.candidates.map(reassembled => {
    if (reassembled.content === undefined) throw new Error('Expected model Content in this replay fixture');
    return reassembled.content;
  });
};

test('a carrier a real codec emits on thoughtSignature decodes on the next turn', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const contents = await modelContents(wrapGeminiGenerateContentAffinityEgress(frames([
    eventFrame({
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ text: 'visible', thoughtSignature: 'upstream-signature' }] },
        finishReason: 'STOP',
      }],
    }),
  ]), { codec, affinity: targetFor(candidateA) }));

  const payload = { model: 'model', contents };
  const prepared = await decodeGeminiGenerateContentAffinity(payload, codec);

  const projectionA = evaluateGeminiGenerateContentAffinity(prepared, candidateA, payload);
  const projectionB = evaluateGeminiGenerateContentAffinity(prepared, candidateB, payload);
  expect(projectionA.degrades).toBe(false);
  expect(projectionB.degrades).toBe(true);
  expect(projectionA.payload.contents?.[0].parts).toEqual([
    { text: 'visible', thoughtSignature: 'upstream-signature' },
  ]);
  expect(projectionB.payload.contents?.[0].parts).toEqual([{ text: 'visible' }]);
});
