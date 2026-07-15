import { expect, test } from 'vitest';

import { CHAT_COMPLETIONS_AFFINITY_DOMAIN } from './domain.ts';
import { prepareChatCompletionsAffinity } from './ingress.ts';
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

test('restores owned opaque state only for its exact candidate', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const carrier = await codec.wrap('upstream-signature', affinityTargetForCandidate(candidateA), CHAT_COMPLETIONS_AFFINITY_DOMAIN);
  const prepared = await prepareChatCompletionsAffinity({
    model: 'model',
    messages: [{ role: 'assistant', content: 'answer', reasoning_opaque: carrier }],
  }, codec);

  expect(prepared.affinities).toEqual([affinityTargetForCandidate(candidateA)]);
  expect(prepared.payloadForCandidate(candidateA).messages[0]).toMatchObject({ reasoning_opaque: 'upstream-signature' });
  expect(prepared.payloadForCandidate(candidateB).messages[0]).not.toHaveProperty('reasoning_opaque');
});
