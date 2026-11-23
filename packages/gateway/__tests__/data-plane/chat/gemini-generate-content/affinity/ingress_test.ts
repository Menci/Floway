import { expect, test } from 'vitest';

import { decodeGeminiGenerateContentAffinity, evaluateGeminiGenerateContentAffinity } from '../../../../../src/data-plane/chat/gemini-generate-content/affinity/analysis.ts';
import { AffinityCodec, type AffinityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
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

const candidateA = candidate('upstream-a');
const candidateB = candidate('upstream-b');

test('removes originless affinity by protocol shape and preserves visible content and foreign signatures', async () => {
  const synthetic = await codec.wrap(undefined, targetFor(candidateA), 'gemini-generate-content.part.thoughtSignature');
  const payload = {
    model: 'model',
    contents: [{
      role: 'model',
      parts: [
        { text: 'answer' },
        { thoughtSignature: synthetic },
        { text: 'synthetic on content', thoughtSignature: synthetic },
        { text: 'foreign', thoughtSignature: 'not-floway' },
      ],
    }],
  };
  const prepared = await decodeGeminiGenerateContentAffinity(payload, codec);

  expect(evaluateGeminiGenerateContentAffinity(prepared, candidateA, payload).payload.contents?.[0].parts).toEqual([
    { text: 'answer' },
    { text: 'synthetic on content' },
    { text: 'foreign', thoughtSignature: 'not-floway' },
  ]);
});

test.each([
  { text: '' },
  { thought: true },
])('removes metadata-only remnants after stripping an incompatible owned signature', async metadata => {
  const owned = await codec.wrap('natural', targetFor(candidateA), 'gemini-generate-content.part.thoughtSignature');
  const payload = {
    model: 'model',
    contents: [{ role: 'model', parts: [{ ...metadata, thoughtSignature: owned }] }],
  };
  const prepared = await decodeGeminiGenerateContentAffinity(payload, codec);

  expect(evaluateGeminiGenerateContentAffinity(prepared, candidateB, payload).payload.contents).toEqual([]);
});

test('drops incompatible thought parts and preserves ordinary text and tool calls', async () => {
  const marker = await codec.wrap(undefined, targetFor(candidateA), 'gemini-generate-content.part.thoughtSignature');
  const native = await codec.wrap('native', targetFor(candidateA), 'gemini-generate-content.part.thoughtSignature');
  const answer = { text: 'answer' };
  const tool = { functionCall: { name: 'lookup', args: {} } };
  const foreign = { text: 'foreign thought', thought: true, thoughtSignature: 'not-floway' };
  const payload = {
    model: 'model',
    contents: [{
      role: 'model',
      parts: [
        { ...answer, thoughtSignature: marker },
        { text: 'reasoning with no separate signature', thought: true },
        { text: 'reasoning with a signature', thought: true, thoughtSignature: native },
        foreign,
        { ...tool, thoughtSignature: native },
      ],
    }],
  };
  const prepared = await decodeGeminiGenerateContentAffinity(payload, codec);

  const compatible = evaluateGeminiGenerateContentAffinity(prepared, candidateA, payload);
  const incompatible = evaluateGeminiGenerateContentAffinity(prepared, candidateB, payload);
  expect(compatible.degrades).toBe(false);
  expect(compatible.payload.contents?.[0].parts).toEqual([
    answer,
    { text: 'reasoning with no separate signature', thought: true },
    { text: 'reasoning with a signature', thought: true, thoughtSignature: 'native' },
    foreign,
    { ...tool, thoughtSignature: 'native' },
  ]);
  expect(incompatible.degrades).toBe(true);
  expect(incompatible.payload.contents?.[0].parts).toEqual([answer, foreign, tool]);
});
