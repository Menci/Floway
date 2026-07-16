import { expect, test } from 'vitest';

import { prepareGeminiAffinity } from './ingress.ts';
import { AffinityCodec, type AffinityTarget } from '../../shared/affinity/index.ts';
import type { ModelCandidate } from '@floway-dev/provider';
import { stubModelCandidate } from '@floway-dev/test-utils';

const codec = new AffinityCodec('22'.repeat(32));

const candidate = (upstream: string): ModelCandidate => {
  const base = stubModelCandidate();
  return stubModelCandidate({
    provider: { ...base.provider, upstream },
    model: { id: 'model' },
  });
};

const targetFor = (value: ModelCandidate): AffinityTarget => ({
  upstreamId: value.provider.upstream,
  modelId: value.model.id,
  ...(value.rules !== undefined ? { rules: value.rules } : {}),
});

const candidateA = candidate('upstream-a');
const candidateB = candidate('upstream-b');

test('removes a synthetic signature-only part and preserves foreign signatures', async () => {
  const synthetic = await codec.wrap(undefined, targetFor(candidateA), 'gemini.part.thoughtSignature');
  const prepared = await prepareGeminiAffinity({
    contents: [{
      role: 'model',
      parts: [
        { text: 'answer' },
        { thoughtSignature: synthetic },
        { text: 'foreign', thoughtSignature: 'not-floway' },
      ],
    }],
  }, codec);

  expect(prepared.payloadForCandidate(candidateA).contents?.[0].parts).toEqual([
    { text: 'answer' },
    { text: 'foreign', thoughtSignature: 'not-floway' },
  ]);
});

test.each([
  { text: '' },
  { thought: true },
])('removes metadata-only remnants after stripping an incompatible owned signature', async metadata => {
  const owned = await codec.wrap('natural', targetFor(candidateA), 'gemini.part.thoughtSignature');
  const prepared = await prepareGeminiAffinity({
    contents: [{ role: 'model', parts: [{ ...metadata, thoughtSignature: owned }] }],
  }, codec);

  expect(prepared.payloadForCandidate(candidateB).contents).toEqual([]);
});

test('preserves unrelated empty model contents', async () => {
  const prepared = await prepareGeminiAffinity({
    contents: [{ role: 'model', parts: [] }],
  }, codec);

  expect(prepared.payloadForCandidate(candidateA).contents).toEqual([{ role: 'model', parts: [] }]);
});
