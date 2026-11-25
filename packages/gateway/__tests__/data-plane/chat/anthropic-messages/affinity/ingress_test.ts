import { expect, test } from 'vitest';

import { analyzeAnthropicMessagesAffinity } from '../../../../../src/data-plane/chat/anthropic-messages/affinity/ingress.ts';
import { AffinityCodec, type AffinityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import type { Candidate } from '../../../../../src/data-plane/pipeline/facts.ts';
import { acceptedAffinityEvaluation, stubChatCandidate } from '../../shared/affinity/helpers.ts';
import type { AnthropicMessagesAssistantContentBlock } from '@floway-dev/protocols/anthropic-messages';

const codec = new AffinityCodec('22'.repeat(32));

const candidate = (upstream: string): Candidate => stubChatCandidate({
  upstream: { id: upstream },
  model: { id: 'model', upstreamModelId: 'model' },
});

const targetFor = (value: Candidate): AffinityIdentity => ({
  upstreamId: value.upstream.id,
  modelId: value.model.id,
  ...(value.rules !== undefined ? { rules: value.rules } : {}),
  opaqueBlobCompatibilityIdentity: { upstreamId: value.upstream.id, key: value.model.id },
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

test('discards marker-only and unsigned thinking on an incompatible turn', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const prefix = await codec.wrap(undefined, targetFor(candidateA), 'anthropic-messages.redacted_thinking.data');
  const marker = await codec.wrap(undefined, targetFor(candidateA), 'anthropic-messages.thinking.signature');
  const answer = { citations: null, type: 'text' as const, text: 'answer' };
  const unsigned = { type: 'thinking', thinking: 'unsigned reasoning' } as AnthropicMessagesAssistantContentBlock;
  const blankSignature = { type: 'thinking' as const, thinking: 'another unsigned block', signature: '' };
  const prepared = await analyzeAnthropicMessagesAffinity({
    model: 'model',
    max_tokens: 100,
    messages: [{
      role: 'assistant',
      content: [
        { type: 'redacted_thinking', data: prefix },
        { type: 'thinking', thinking: 'marked reasoning', signature: marker },
        unsigned,
        blankSignature,
        { type: 'thinking', thinking: 'foreign reasoning', signature: 'foreign' },
        answer,
      ],
    }],
  }, codec);

  const compatible = acceptedAffinityEvaluation(prepared, candidateA);
  const incompatible = acceptedAffinityEvaluation(prepared, candidateB);
  expect(compatible.degrades).toBe(false);
  expect(compatible.materialize().messages[0].content).toEqual([
    { type: 'thinking', thinking: 'marked reasoning' },
    unsigned,
    blankSignature,
    { type: 'thinking', thinking: 'foreign reasoning', signature: 'foreign' },
    answer,
  ]);
  expect(incompatible.degrades).toBe(true);
  expect(incompatible.materialize().messages[0].content).toEqual([
    { type: 'thinking', thinking: 'foreign reasoning', signature: 'foreign' },
    answer,
  ]);
});
