import { expect, test } from 'vitest';

import { analyzeAnthropicMessagesAffinity } from '../../../../../src/data-plane/chat/anthropic-messages/affinity/ingress.ts';
import { AffinityCodec, type AffinityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
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

const targetFor = (value: ModelCandidate): AffinityIdentity => ({
  upstreamId: value.provider.upstreamId,
  modelId: value.model.id,
  ...(value.rules !== undefined ? { rules: value.rules } : {}),
  opaqueBlobCompatibilityIdentity: { upstreamId: value.provider.upstreamId, key: value.model.id },
});

test('removes thinking and redacted blocks whose affinity belongs to another candidate', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const signature = await codec.wrap('signature', targetFor(candidateA), 'anthropic-messages.thinking.signature');
  const synthetic = await codec.wrap(undefined, targetFor(candidateA), 'anthropic-messages.redacted_thinking.data');
  const prepared = await analyzeAnthropicMessagesAffinity({
    model: 'model',
    max_tokens: 100,
    messages: [{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'visible reasoning', signature },
        { type: 'redacted_thinking', data: synthetic },
        { citations: null, type: 'text', text: 'answer' },
      ],
    }],
  }, codec);

  expect(acceptedAffinityEvaluation(prepared, candidateA).materialize().messages[0]).toEqual({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'visible reasoning', signature: 'signature' },
      { citations: null, type: 'text', text: 'answer' },
    ],
  });
  expect(acceptedAffinityEvaluation(prepared, candidateB).materialize().messages[0]).toEqual({
    role: 'assistant',
    content: [
      { citations: null, type: 'text', text: 'answer' },
    ],
  });
});
