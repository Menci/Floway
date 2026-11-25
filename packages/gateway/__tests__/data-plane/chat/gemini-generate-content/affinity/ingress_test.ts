import { expect, test } from 'vitest';

import { analyzeGeminiGenerateContentAffinity } from '../../../../../src/data-plane/chat/gemini-generate-content/affinity/ingress.ts';
import { AffinityCodec, type AffinityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import type { Candidate } from '../../../../../src/data-plane/pipeline/facts.ts';
import { acceptedAffinityEvaluation, stubChatCandidate } from '../../shared/affinity/helpers.ts';

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

const candidateA = candidate('upstream-a');
const candidateB = candidate('upstream-b');

test('removes originless affinity by protocol shape and preserves visible content and foreign signatures', async () => {
  const synthetic = await codec.wrap(undefined, targetFor(candidateA), 'gemini-generate-content.part.thoughtSignature');
  const prepared = await analyzeGeminiGenerateContentAffinity({
    contents: [{
      role: 'model',
      parts: [
        { text: 'answer' },
        { thoughtSignature: synthetic },
        { text: 'synthetic on content', thoughtSignature: synthetic },
        { text: 'foreign', thoughtSignature: 'not-floway' },
      ],
    }],
  }, codec);

  expect(acceptedAffinityEvaluation(prepared, candidateA).materialize().contents?.[0].parts).toEqual([
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
  const prepared = await analyzeGeminiGenerateContentAffinity({
    contents: [{ role: 'model', parts: [{ ...metadata, thoughtSignature: owned }] }],
  }, codec);

  expect(acceptedAffinityEvaluation(prepared, candidateB).materialize().contents).toEqual([]);
});

test('drops incompatible thought parts and preserves ordinary text and tool calls', async () => {
  const marker = await codec.wrap(undefined, targetFor(candidateA), 'gemini-generate-content.part.thoughtSignature');
  const native = await codec.wrap('native', targetFor(candidateA), 'gemini-generate-content.part.thoughtSignature');
  const answer = { text: 'answer' };
  const tool = { functionCall: { name: 'lookup', args: {} } };
  const foreign = { text: 'foreign thought', thought: true, thoughtSignature: 'not-floway' };
  const prepared = await analyzeGeminiGenerateContentAffinity({
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
  }, codec);

  const compatible = acceptedAffinityEvaluation(prepared, candidateA);
  const incompatible = acceptedAffinityEvaluation(prepared, candidateB);
  expect(compatible.degrades).toBe(false);
  expect(compatible.materialize().contents?.[0].parts).toEqual([
    answer,
    { text: 'reasoning with no separate signature', thought: true },
    { text: 'reasoning with a signature', thought: true, thoughtSignature: 'native' },
    foreign,
    { ...tool, thoughtSignature: 'native' },
  ]);
  expect(incompatible.degrades).toBe(true);
  expect(incompatible.materialize().contents?.[0].parts).toEqual([answer, foreign, tool]);
});
