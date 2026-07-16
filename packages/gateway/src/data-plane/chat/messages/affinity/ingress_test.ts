import { expect, test } from 'vitest';

import { prepareMessagesAffinity } from './ingress.ts';
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

test('removes synthetic blocks and strips incompatible signatures without hiding thinking', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const signature = await codec.wrap('signature', affinityTargetForCandidate(candidateA), 'messages.thinking.signature');
  const synthetic = await codec.wrap(undefined, affinityTargetForCandidate(candidateA), 'messages.redacted_thinking.data');
  const prepared = await prepareMessagesAffinity({
    model: 'model',
    max_tokens: 100,
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'visible reasoning', signature },
        { type: 'redacted_thinking', data: synthetic },
        { type: 'text', text: 'answer' },
      ],
    }],
  }, codec);

  expect(prepared.payloadForCandidate(candidateA).messages[0]).toEqual({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'visible reasoning', signature: 'signature' },
      { type: 'text', text: 'answer' },
    ],
  });
  expect(prepared.payloadForCandidate(candidateB).messages[0]).toEqual({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'visible reasoning' },
      { type: 'text', text: 'answer' },
    ],
  });
});
