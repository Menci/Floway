import { expect, test } from 'vitest';

import { analyzeAnthropicMessagesAffinity } from '../../../../../src/data-plane/chat/anthropic-messages/affinity/ingress.ts';
import type { RouteAffinityRequestAnalysis, CandidateAffinityEvaluation } from '../../../../../src/data-plane/chat/pipeline/index.ts';
import { AffinityCodec, type AffinityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { stubRouteCandidate } from '../../../../test-utils/chat-pipeline.ts';
import type { RouteCandidate } from '@floway-dev/provider';

const codec = new AffinityCodec('22'.repeat(32));

const candidate = (upstream: string): RouteCandidate => stubRouteCandidate({ upstreamId: upstream, modelId: 'model' });

const targetFor = (value: RouteCandidate): AffinityIdentity => ({
  upstreamId: value.upstreamId,
  modelId: value.modelId,
  ...(value.rules !== undefined ? { rules: value.rules } : {}),
  opaqueBlobCompatibilityIdentity: { upstreamId: value.upstreamId, key: value.upstreamModelId },
});

const acceptedAffinityEvaluation = <T>(
  analysis: RouteAffinityRequestAnalysis<T>,
  value: RouteCandidate,
): Extract<CandidateAffinityEvaluation<T>, { kind: 'accepted' }> => {
  const evaluation = analysis.evaluateCandidate(value);
  if (evaluation.kind === 'rejected') throw new Error('Expected accepted affinity candidate');
  return evaluation;
};

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
