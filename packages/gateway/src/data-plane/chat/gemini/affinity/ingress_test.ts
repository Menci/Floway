import { expect, test } from 'vitest';

import { GEMINI_AFFINITY_DOMAIN } from './domain.ts';
import { prepareGeminiAffinity } from './ingress.ts';
import { affinityTargetForCandidate } from '../../shared/affinity/candidate.ts';
import { AffinityCodec } from '../../shared/affinity/codec.ts';
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

const candidateA = candidate('upstream-a');

test('removes a synthetic signature-only part and preserves foreign signatures', async () => {
  const synthetic = await codec.wrap(undefined, affinityTargetForCandidate(candidateA), GEMINI_AFFINITY_DOMAIN);
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

test('preserves unrelated empty model contents', async () => {
  const prepared = await prepareGeminiAffinity({
    contents: [{ role: 'model', parts: [] }],
  }, codec);

  expect(prepared.payloadForCandidate(candidateA).contents).toEqual([{ role: 'model', parts: [] }]);
});
