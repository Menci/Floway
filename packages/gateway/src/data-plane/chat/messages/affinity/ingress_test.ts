import { expect, test } from 'vitest';

import { prepareMessagesAffinity } from './ingress.ts';
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

test('removes synthetic blocks and strips incompatible signatures without hiding thinking', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const signature = await codec.wrap('signature', targetFor(candidateA), 'messages.thinking.signature');
  const synthetic = await codec.wrap(undefined, targetFor(candidateA), 'messages.redacted_thinking.data');
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

test('removes assistant messages emptied by affinity block stripping', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const synthetic = await codec.wrap(undefined, targetFor(candidateA), 'messages.redacted_thinking.data');
  const natural = await codec.wrap('natural', targetFor(candidateA), 'messages.redacted_thinking.data');

  const syntheticPrepared = await prepareMessagesAffinity({
    model: 'model',
    max_tokens: 100,
    messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: synthetic }] }],
  }, codec);
  expect(syntheticPrepared.payloadForCandidate(candidateA).messages).toEqual([]);
  expect(syntheticPrepared.payloadForCandidate(candidateB).messages).toEqual([]);

  const naturalPrepared = await prepareMessagesAffinity({
    model: 'model',
    max_tokens: 100,
    messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: natural }] }],
  }, codec);
  expect(naturalPrepared.payloadForCandidate(candidateA).messages).toEqual([
    { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'natural' }] },
  ]);
  expect(naturalPrepared.payloadForCandidate(candidateB).messages).toEqual([]);
});
