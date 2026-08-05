import { expect, test } from 'vitest';

import { analyzeMessagesAffinity } from '../../../../../src/data-plane/chat/messages/affinity/ingress.ts';
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

test('removes synthetic blocks and strips incompatible signatures without hiding thinking', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const signature = await codec.wrap('signature', targetFor(candidateA), 'messages.thinking.signature');
  const synthetic = await codec.wrap(undefined, targetFor(candidateA), 'messages.redacted_thinking.data');
  const prepared = await analyzeMessagesAffinity({
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

  expect(acceptedAffinityEvaluation(prepared, candidateA).materialize().messages[0]).toEqual({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'visible reasoning', signature: 'signature' },
      { type: 'text', text: 'answer' },
    ],
  });
  expect(acceptedAffinityEvaluation(prepared, candidateB).materialize().messages[0]).toEqual({
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

  const syntheticPrepared = await analyzeMessagesAffinity({
    model: 'model',
    max_tokens: 100,
    messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: synthetic }] }],
  }, codec);
  expect(acceptedAffinityEvaluation(syntheticPrepared, candidateA).materialize().messages).toEqual([]);
  expect(acceptedAffinityEvaluation(syntheticPrepared, candidateB).materialize().messages).toEqual([]);

  const naturalPrepared = await analyzeMessagesAffinity({
    model: 'model',
    max_tokens: 100,
    messages: [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: natural }] }],
  }, codec);
  expect(acceptedAffinityEvaluation(naturalPrepared, candidateA).materialize().messages).toEqual([
    { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'natural' }] },
  ]);
  expect(acceptedAffinityEvaluation(naturalPrepared, candidateB).materialize().messages).toEqual([]);
});
