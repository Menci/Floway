import { expect, test } from 'vitest';

import { analyzeChatCompletionsAffinity } from '../../../../../src/data-plane/chat/chat-completions/affinity/ingress.ts';
import { AffinityCodec, type AffinityTarget } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { acceptedAffinityEvaluation } from '../../shared/affinity/helpers.ts';
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

test('restores owned opaque state only for its exact candidate', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const carrier = await codec.wrap('upstream-signature', targetFor(candidateA), 'chat-completions.reasoning_opaque');
  const prepared = await analyzeChatCompletionsAffinity({
    model: 'model',
    messages: [{ role: 'assistant', content: 'answer', reasoning_opaque: carrier }],
  }, codec);

  const projectionA = acceptedAffinityEvaluation(prepared, candidateA);
  const projectionB = acceptedAffinityEvaluation(prepared, candidateB);
  expect(projectionA.degrades).toBe(false);
  expect(projectionB.degrades).toBe(true);
  expect(projectionA.materialize().messages[0]).toMatchObject({ reasoning_opaque: 'upstream-signature' });
  expect(projectionB.materialize().messages[0]).not.toHaveProperty('reasoning_opaque');
});
