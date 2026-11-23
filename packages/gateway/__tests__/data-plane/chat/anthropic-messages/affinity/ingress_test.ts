import { expect, test } from 'vitest';

import { analyzeAnthropicMessagesAffinity, evaluateAnthropicMessagesAffinity, scoreAnthropicMessagesAffinity } from '../../../../../src/data-plane/chat/anthropic-messages/affinity/analysis.ts';
import { AffinityCodec } from '../../../../../src/data-plane/chat/shared/affinity/carrier.ts';
import { affinityIdentityForCandidate as targetFor } from '../../../../../src/data-plane/chat/shared/affinity/selection.ts';
import { messagesUpstream } from '../fixture.ts';
import type { AnthropicMessagesAssistantContentBlock, AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

const codec = new AffinityCodec('22'.repeat(32));

const candidate = (upstreamId: string) => messagesUpstream({ upstreamId, model: 'model' }).candidate;

test('removes thinking and redacted blocks whose affinity belongs to another candidate', async () => {
  const candidateA = candidate('upstream-a');
  const candidateB = candidate('upstream-b');
  const signature = await codec.wrap('signature', targetFor(candidateA), 'anthropic-messages.thinking.signature');
  const synthetic = await codec.wrap(undefined, targetFor(candidateA), 'anthropic-messages.redacted_thinking.data');
  const payload: AnthropicMessagesPayload = {
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
  };
  const prepared = await analyzeAnthropicMessagesAffinity(payload, codec);

  expect(evaluateAnthropicMessagesAffinity(prepared, candidateA, payload).payload.messages[0]).toEqual({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'visible reasoning', signature: 'signature' },
      { citations: null, type: 'text', text: 'answer' },
    ],
  });
  expect(evaluateAnthropicMessagesAffinity(prepared, candidateB, payload).payload.messages[0]).toEqual({
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
  const payload: AnthropicMessagesPayload = {
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
  };
  const prepared = await analyzeAnthropicMessagesAffinity(payload, codec);

  const compatible = evaluateAnthropicMessagesAffinity(prepared, candidateA, payload);
  const incompatible = evaluateAnthropicMessagesAffinity(prepared, candidateB, payload);
  expect(scoreAnthropicMessagesAffinity(prepared, candidateA, payload)).toEqual({ kind: 'accepted', degrades: false, preferred: true });
  expect(scoreAnthropicMessagesAffinity(prepared, candidateB, payload)).toEqual({ kind: 'accepted', degrades: true, preferred: true });
  expect(compatible.degrades).toBe(false);
  expect(compatible.payload.messages[0].content).toEqual([
    { type: 'thinking', thinking: 'marked reasoning' },
    unsigned,
    blankSignature,
    { type: 'thinking', thinking: 'foreign reasoning', signature: 'foreign' },
    answer,
  ]);
  expect(incompatible.degrades).toBe(true);
  expect(incompatible.payload.messages[0].content).toEqual([
    { type: 'thinking', thinking: 'foreign reasoning', signature: 'foreign' },
    answer,
  ]);
});
