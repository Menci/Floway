import { expect, test } from 'vitest';

import { analyzeOpenAIResponsesAffinity } from '../../../../../src/data-plane/chat/openai-responses/affinity/ingress.ts';
import { AffinityCodec, type AffinityIdentity, type AffinityRequestAnalysis, compatibilityIdentityForCandidate, selectAffinityCandidates } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { acceptedAffinityEvaluation } from '../../shared/affinity/helpers.ts';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { ModelCandidate } from '@floway-dev/provider';
import { stubModelCandidate, stubProviderModel } from '@floway-dev/test-utils';

const codec = new AffinityCodec('22'.repeat(32));
const canonicalItemType = (itemType: string): string => itemType === 'compaction' || itemType === 'compaction_summary' || itemType === 'context_compaction' ? 'compaction' : itemType;
const carrierDomain = (itemType: string, slot: string): string => `openai-responses.${canonicalItemType(itemType)}.${slot}`;

const candidate = (
  upstream: string,
  model = 'model',
  scope: { bindToUpstream: boolean; key?: string } = { bindToUpstream: true },
): ModelCandidate => {
  const base = stubModelCandidate();
  return stubModelCandidate({
    provider: { ...base.provider, upstreamId: upstream },
    model: {
      id: model,
      opaqueBlobCompatibilityScope: scope,
      providerModels: {
        [upstream]: stubProviderModel({
          id: model,
          upstreamModelId: model,
          opaqueBlobCompatibilityScope: scope,
        }),
      },
    },
  });
};

const targetFor = (value: ModelCandidate): AffinityIdentity => ({
  upstreamId: value.provider.upstreamId,
  modelId: value.model.id,
  ...(value.rules !== undefined ? { rules: value.rules } : {}),
  opaqueBlobCompatibilityIdentity: compatibilityIdentityForCandidate(value),
});

const candidateA = candidate('upstream-a');
const candidateB = candidate('upstream-b');

const select = (
  candidates: readonly ModelCandidate[],
  analysis: AffinityRequestAnalysis<CanonicalOpenAIResponsesPayload>,
) => {
  const selection = selectAffinityCandidates(candidates, analysis);
  if ('kind' in selection) throw new Error(`Expected affinity selection, received ${selection.kind}`);
  return selection;
};

test('restores an owned blob within its compatibility scope and still prefers its exact target', async () => {
  const mismatchedRules = { ...candidateA, rules: { reasoning: { effort: 'low' } } };
  const carrier = await codec.wrap(
    'encrypted',
    targetFor(candidateA),
    carrierDomain('reasoning', 'encrypted_content'),
  );
  const prepared = await analyzeOpenAIResponsesAffinity({
    model: 'model',
    input: [{ type: 'reasoning', id: 'rs_client', summary: [{ type: 'summary_text', text: 'visible' }], encrypted_content: carrier }],
  }, codec);

  const projectionA = acceptedAffinityEvaluation(prepared, candidateA);
  const projectionB = acceptedAffinityEvaluation(prepared, candidateB);
  const mismatchedProjection = acceptedAffinityEvaluation(prepared, mismatchedRules);
  expect(projectionA.materialize().input).toEqual([{
    type: 'reasoning',
    id: 'rs_client',
    summary: [{ type: 'summary_text', text: 'visible' }],
    encrypted_content: 'encrypted',
  }]);
  expect(projectionB.materialize().input).toEqual([{
    type: 'reasoning',
    id: 'rs_client',
    summary: [{ type: 'summary_text', text: 'visible' }],
  }]);
  expect(projectionA.degrades).toBe(false);
  expect(mismatchedProjection.degrades).toBe(false);
  expect(select([mismatchedRules, candidateA], prepared).candidates).toEqual([candidateA, mismatchedRules]);
});

test('rewrites nested agent-message carriers and preserves foreign values', async () => {
  const first = await codec.wrap(
    'first',
    targetFor(candidateA),
    carrierDomain('agent_message', 'content.0.encrypted_content'),
  );
  const synthetic = await codec.wrap(
    undefined,
    targetFor(candidateA),
    carrierDomain('agent_message', 'content.1.encrypted_content'),
  );
  const prepared = await analyzeOpenAIResponsesAffinity({
    model: 'model',
    input: [{
      type: 'agent_message',
      id: 'amsg_client',
      author: 'a',
      recipient: 'b',
      content: [
        { type: 'encrypted_content', encrypted_content: first },
        { type: 'encrypted_content', encrypted_content: synthetic },
        { type: 'encrypted_content', encrypted_content: 'foreign' },
        { type: 'input_text', text: 'visible' },
      ],
    }],
  }, codec);

  const projectionA = acceptedAffinityEvaluation(prepared, candidateA);
  const projectionB = acceptedAffinityEvaluation(prepared, candidateB);
  expect(projectionA.materialize().input[0]).toMatchObject({
    id: 'amsg_client',
    content: [
      { type: 'encrypted_content', encrypted_content: 'first' },
      { type: 'encrypted_content', encrypted_content: 'foreign' },
      { type: 'input_text', text: 'visible' },
    ],
  });
  expect(projectionB.materialize().input[0]).toMatchObject({
    id: 'amsg_client',
    content: [
      { type: 'encrypted_content', encrypted_content: 'foreign' },
      { type: 'input_text', text: 'visible' },
    ],
  });
  expect(projectionA.degrades).toBe(false);
  expect(projectionB.degrades).toBe(true);
});

test('removes only items explicitly marked synthetic and preserves markerless originless items', async () => {
  const syntheticItem = await codec.wrap(
    undefined,
    targetFor(candidateA),
    carrierDomain('reasoning', 'encrypted_content'),
    { syntheticItem: true },
  );
  const markerless = await codec.wrap(
    undefined,
    targetFor(candidateA),
    carrierDomain('reasoning', 'encrypted_content'),
  );
  const prepared = await analyzeOpenAIResponsesAffinity({
    model: 'model',
    input: [
      {
        type: 'reasoning',
        summary: [],
        content: null,
        status: 'completed',
        encrypted_content: syntheticItem,
      } as unknown as CanonicalOpenAIResponsesPayload['input'][number],
      { type: 'reasoning', id: 'rs_existing', summary: [], encrypted_content: markerless },
      {
        type: 'reasoning',
        id: 'rs_visible',
        summary: [{ type: 'summary_text', text: 'visible' }],
        encrypted_content: markerless,
      },
    ],
  }, codec);

  const markerlessItems = [
    { type: 'reasoning', id: 'rs_existing', summary: [] },
    {
      type: 'reasoning',
      id: 'rs_visible',
      summary: [{ type: 'summary_text', text: 'visible' }],
    },
  ];
  const projectionA = acceptedAffinityEvaluation(prepared, candidateA);
  const projectionB = acceptedAffinityEvaluation(prepared, candidateB);
  expect(projectionA.materialize().input).toEqual(markerlessItems);
  expect(projectionB.materialize().input).toEqual(markerlessItems);
  expect(projectionA.degrades).toBe(false);
  expect(projectionB.degrades).toBe(false);
});

test('derives force routing from blob-less program state after the turn carrier', async () => {
  const firstVariant = { ...candidateA, rules: { reasoning: { effort: 'low' } } };
  const lastRoutedVariant = { ...candidateA, rules: { reasoning: { effort: 'high' } } };
  const carrier = await codec.wrap(
    undefined,
    targetFor(lastRoutedVariant),
    carrierDomain('reasoning', 'encrypted_content'),
    { syntheticItem: true },
  );
  const prepared = await analyzeOpenAIResponsesAffinity({
    model: 'model',
    input: [
      { type: 'reasoning', id: 'rs_prefix', summary: [], encrypted_content: carrier },
      { type: 'program_output', id: 'prog_out_client', call_id: 'call_1', result: 'done', status: 'completed' },
    ],
  }, codec);

  expect(prepared.requiredTargets).toEqual([targetFor(lastRoutedVariant)]);
  expect(prepared.evaluateCandidate(candidateB)).toEqual({ kind: 'rejected' });
  const selection = select([firstVariant, lastRoutedVariant, candidateB], prepared);
  expect(selection.candidates).toEqual([
    firstVariant,
    lastRoutedVariant,
  ]);
  const firstEvaluation = acceptedAffinityEvaluation(prepared, firstVariant);
  expect(firstEvaluation.degrades).toBe(false);
  expect(selection.payloadFor(firstVariant).input).toEqual([{
    type: 'program_output',
    id: 'prog_out_client',
    call_id: 'call_1',
    result: 'done',
    status: 'completed',
  }]);
});

test('does not inherit force through a foreign program blob', async () => {
  const carrier = await codec.wrap(
    undefined,
    targetFor(candidateA),
    carrierDomain('reasoning', 'encrypted_content'),
    { syntheticItem: true },
  );
  const prepared = await analyzeOpenAIResponsesAffinity({
    model: 'model',
    input: [
      { type: 'reasoning', id: 'rs_prefix', summary: [], encrypted_content: carrier },
      { type: 'program', id: 'prog_client', call_id: 'call_1', code: 'return 1', fingerprint: 'foreign' },
    ],
  }, codec);

  expect(prepared.requiredTargets).toEqual([]);
  expect(acceptedAffinityEvaluation(prepared, candidateA).materialize().input[0]).toMatchObject({ fingerprint: 'foreign' });
});
