import { expect, test } from 'vitest';

import { analyzeResponsesAffinity } from '../../../../../src/data-plane/chat/responses/affinity/ingress.ts';
import { AffinityCodec, type AffinityRequestAnalysis, type AffinityTarget, selectAffinityCandidates } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { acceptedAffinityEvaluation } from '../../shared/affinity/helpers.ts';
import type { CanonicalResponsesPayload } from '@floway-dev/protocols/responses';
import type { ModelCandidate } from '@floway-dev/provider';
import { stubModelCandidate } from '@floway-dev/test-utils';

const codec = new AffinityCodec('22'.repeat(32));
const canonicalItemType = (itemType: string): string => itemType === 'compaction_summary' ? 'compaction' : itemType;
const carrierDomain = (itemType: string, slot: string): string => `responses.${canonicalItemType(itemType)}.${slot}`;

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

const candidateA = candidate('upstream-a');
const candidateB = candidate('upstream-b');

const select = (
  candidates: readonly ModelCandidate[],
  analysis: AffinityRequestAnalysis<CanonicalResponsesPayload>,
) => {
  const selection = selectAffinityCandidates(candidates, analysis);
  if ('kind' in selection) throw new Error(`Expected affinity selection, received ${selection.kind}`);
  return selection;
};

test('restores an owned blob only for its exact target without changing item ids', async () => {
  const mismatchedRules = { ...candidateA, rules: { reasoning: { effort: 'low' } } };
  const carrier = await codec.wrap(
    'encrypted',
    targetFor(candidateA),
    carrierDomain('reasoning', 'encrypted_content'),
  );
  const prepared = await analyzeResponsesAffinity({
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
  expect(mismatchedProjection.degrades).toBe(true);
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
  const prepared = await analyzeResponsesAffinity({
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
  const prepared = await analyzeResponsesAffinity({
    model: 'model',
    input: [
      {
        type: 'reasoning',
        summary: [],
        content: null,
        status: 'completed',
        encrypted_content: syntheticItem,
      } as unknown as CanonicalResponsesPayload['input'][number],
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
  const prepared = await analyzeResponsesAffinity({
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
  const prepared = await analyzeResponsesAffinity({
    model: 'model',
    input: [
      { type: 'reasoning', id: 'rs_prefix', summary: [], encrypted_content: carrier },
      { type: 'program', id: 'prog_client', call_id: 'call_1', code: 'return 1', fingerprint: 'foreign' },
    ],
  }, codec);

  expect(prepared.requiredTargets).toEqual([]);
  expect(acceptedAffinityEvaluation(prepared, candidateA).materialize().input[0]).toMatchObject({ fingerprint: 'foreign' });
});

test('treats compaction_summary as force state across alias-rule variants', async () => {
  const firstVariant = { ...candidateA, rules: { reasoning: { effort: 'low' } } };
  const lastRoutedVariant = { ...candidateA, rules: { reasoning: { effort: 'high' } } };
  const carrier = await codec.wrap(
    'opaque',
    targetFor(lastRoutedVariant),
    carrierDomain('compaction_summary', 'encrypted_content'),
  );
  const item = { type: 'compaction_summary', id: 'cmp_client', encrypted_content: carrier } as unknown as CanonicalResponsesPayload['input'][number];
  const prepared = await analyzeResponsesAffinity({ model: 'model', input: [item] }, codec);

  expect(prepared.requiredTargets).toEqual([targetFor(lastRoutedVariant)]);
  expect(prepared.evaluateCandidate(candidateB)).toMatchObject({ kind: 'rejected' });
  const selection = select([firstVariant, lastRoutedVariant, candidateB], prepared);
  expect(selection.candidates).toEqual([
    firstVariant,
    lastRoutedVariant,
  ]);
  expect(selection.payloadFor(firstVariant).input[0]).toMatchObject({
    id: 'cmp_client',
    encrypted_content: 'opaque',
  });
});

test('lets originless context compaction follow candidate order while natural encrypted state forces', async () => {
  const synthetic = await codec.wrap(undefined, targetFor(candidateA), carrierDomain('context_compaction', 'encrypted_content'));
  const originlessItem = {
    type: 'context_compaction',
    id: 'ctx_client',
    encrypted_content: synthetic,
  } as unknown as CanonicalResponsesPayload['input'][number];
  const syntheticPrepared = await analyzeResponsesAffinity({ model: 'model', input: [originlessItem] }, codec);
  expect(syntheticPrepared.requiredTargets).toEqual([]);
  expect(syntheticPrepared.evaluateCandidate(candidateB)).toMatchObject({ kind: 'accepted', degrades: false });

  const natural = await codec.wrap('opaque', targetFor(candidateA), carrierDomain('context_compaction', 'encrypted_content'));
  const naturalPrepared = await analyzeResponsesAffinity({
    model: 'model',
    input: [{ ...originlessItem, encrypted_content: natural } as CanonicalResponsesPayload['input'][number]],
  }, codec);
  expect(naturalPrepared.requiredTargets).toEqual([targetFor(candidateA)]);
  expect(naturalPrepared.evaluateCandidate(candidateA)).toMatchObject({ kind: 'accepted', degrades: false });
  expect(naturalPrepared.evaluateCandidate(candidateB)).toMatchObject({ kind: 'rejected' });
});

test('evaluates required eligibility and optional degradation in one candidate projection', async () => {
  const high = { ...candidateA, rules: { reasoning: { effort: 'high' } } };
  const low = { ...candidateA, rules: { reasoning: { effort: 'low' } } };
  const required = await codec.wrap(
    'compaction-state',
    targetFor(high),
    carrierDomain('compaction', 'encrypted_content'),
  );
  const optional = await codec.wrap(
    'reasoning-state',
    targetFor(low),
    carrierDomain('reasoning', 'encrypted_content'),
  );
  const prepared = await analyzeResponsesAffinity({
    model: 'model',
    input: [
      { type: 'compaction', id: 'cmp_client', encrypted_content: required },
      { type: 'reasoning', id: 'rs_client', summary: [], encrypted_content: optional },
    ] as CanonicalResponsesPayload['input'],
  }, codec);

  expect(prepared.evaluateCandidate(high)).toMatchObject({ kind: 'accepted', degrades: true });
  expect(prepared.evaluateCandidate(low)).toMatchObject({ kind: 'accepted', degrades: false });
  expect(prepared.evaluateCandidate(candidateB)).toMatchObject({ kind: 'rejected' });
  expect(select([high, low, candidateB], prepared).candidates).toEqual([low, high]);
});

test('reports incompatible required state discovered by the same item analysis', async () => {
  const requiredA = await codec.wrap(
    'state-a',
    targetFor(candidateA),
    carrierDomain('compaction', 'encrypted_content'),
  );
  const requiredB = await codec.wrap(
    'state-b',
    targetFor(candidateB),
    carrierDomain('compaction', 'encrypted_content'),
  );
  const prepared = await analyzeResponsesAffinity({
    model: 'model',
    input: [
      { type: 'compaction', id: 'cmp_a', encrypted_content: requiredA },
      { type: 'compaction', id: 'cmp_b', encrypted_content: requiredB },
    ] as CanonicalResponsesPayload['input'],
  }, codec);

  expect(selectAffinityCandidates([candidateA, candidateB], prepared)).toMatchObject({
    kind: 'routing-unavailable',
    message: expect.stringContaining('multiple incompatible targets'),
  });
});
