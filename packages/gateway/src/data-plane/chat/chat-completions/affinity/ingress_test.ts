import { expect, test } from 'vitest';

import { prepareChatCompletionsAffinity } from './ingress.ts';
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

test('restores owned opaque state only for its exact candidate', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const carrier = await codec.wrap('upstream-signature', targetFor(candidateA), 'chat-completions.reasoning_opaque');
  const prepared = await prepareChatCompletionsAffinity({
    model: 'model',
    messages: [{ role: 'assistant', content: 'answer', reasoning_opaque: carrier }],
  }, codec);

  expect(prepared.routingEvidence).toEqual([{ target: targetFor(candidateA), mode: 'prefer' }]);
  expect(prepared.payloadForCandidate(candidateA).messages[0]).toMatchObject({ reasoning_opaque: 'upstream-signature' });
  expect(prepared.payloadForCandidate(candidateB).messages[0]).not.toHaveProperty('reasoning_opaque');
});
