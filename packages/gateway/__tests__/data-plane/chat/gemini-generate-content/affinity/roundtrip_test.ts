import { expect, test } from 'vitest';

import { wrapGeminiGenerateContentAffinityEgress } from '../../../../../src/data-plane/chat/gemini-generate-content/affinity/egress.ts';
import { analyzeGeminiGenerateContentAffinity } from '../../../../../src/data-plane/chat/gemini-generate-content/affinity/ingress.ts';
import { affinityIdentityForCandidate } from '../../../../../src/data-plane/chat/shared/affinity/context.ts';
import { AffinityCodec } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { acceptedAffinityEvaluation, affinityTestCandidate } from '../../shared/affinity/helpers.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { reassembleGeminiGenerateContentEvents, type GeminiGenerateContentContent, type GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';

const codec = new AffinityCodec('22'.repeat(32));

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
  const candidateA = affinityTestCandidate('upstream-a');
  const candidateB = affinityTestCandidate('upstream-b');
  const contents = await modelContents(wrapGeminiGenerateContentAffinityEgress(frames([
    eventFrame({
      candidates: [{
        index: 0,
        content: { role: 'model', parts: [{ text: 'visible', thoughtSignature: 'upstream-signature' }] },
        finishReason: 'STOP',
      }],
    }),
  ]), { codec, affinity: affinityIdentityForCandidate(candidateA) }));

  const prepared = await analyzeGeminiGenerateContentAffinity({ contents }, codec);

  const projectionA = acceptedAffinityEvaluation(prepared, candidateA);
  const projectionB = acceptedAffinityEvaluation(prepared, candidateB);
  expect(projectionA.degrades).toBe(false);
  expect(projectionB.degrades).toBe(true);
  expect(projectionA.materialize().contents?.[0].parts).toEqual([
    { text: 'visible', thoughtSignature: 'upstream-signature' },
  ]);
  expect(projectionB.materialize().contents?.[0].parts).toEqual([{ text: 'visible' }]);
});
