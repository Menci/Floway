import { expect, test } from 'vitest';

import { affinityCandidate } from './fixture.ts';
import { analyzeOpenAIResponsesAffinity, evaluateOpenAIResponsesCandidate, scoreOpenAIResponsesCandidate } from '../../../../../src/data-plane/chat/openai-responses/affinity/ingress.ts';
import { AffinityCodec, type AffinityIdentity } from '../../../../../src/data-plane/chat/shared/affinity/carrier.ts';
import { affinityIdentityForCandidate } from '../../../../../src/data-plane/chat/shared/affinity/selection.ts';
import { selectChatCandidates } from '../../../../../src/data-plane/chat/shared/affinity/stages.ts';
import { openaiResponsesTarget } from '../../../../../src/data-plane/chat/shared/target-picker.ts';
import type { RouteCandidate } from '../../../../../src/data-plane/pipeline/services.ts';
import { type CanonicalOpenAIResponsesPayload, canonicalizeOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

const codec = new AffinityCodec('22'.repeat(32));
const canonicalItemType = (itemType: string): string => itemType === 'compaction' || itemType === 'compaction_summary' || itemType === 'context_compaction' ? 'compaction' : itemType;
const carrierDomain = (itemType: string, slot: string): string => `openai-responses.${canonicalItemType(itemType)}.${slot}`;

const candidate = affinityCandidate;
const targetFor = (candidate: RouteCandidate): AffinityIdentity => affinityIdentityForCandidate(candidate);

const candidateA = candidate('upstream-a', 'model');
const candidateB = candidate('upstream-b', 'model');

const prepare = async (payload: CanonicalOpenAIResponsesPayload) => ({
  payload, analysis: await analyzeOpenAIResponsesAffinity(payload, codec),
});
type Prepared = Awaited<ReturnType<typeof prepare>>;

const select = (candidates: readonly RouteCandidate[], { analysis, payload }: Prepared) => {
  const selection = selectChatCandidates(candidates, openaiResponsesTarget, analysis, payload, scoreOpenAIResponsesCandidate, payload.model);
  if ('status' in selection) throw new Error(`Unexpected affinity failure: ${selection.message}`);
  return selection;
};

const project = ({ analysis, payload }: Prepared, candidate: RouteCandidate) => {
  const evaluation = evaluateOpenAIResponsesCandidate(analysis, candidate, payload);
  if (evaluation.kind === 'rejected') throw new Error('Expected accepted affinity projection');
  return evaluation;
};

test('restores an owned blob within its compatibility scope and still prefers its exact target', async () => {
  const mismatchedRules = { ...candidateA, rules: { reasoning: { effort: 'low' } } };
  const compatibleModel = candidate('upstream-a', 'another-model', { bindToUpstream: true, key: 'model' });
  const carrier = await codec.wrap(
    'encrypted',
    targetFor(candidateA),
    carrierDomain('reasoning', 'encrypted_content'),
  );
  const prepared = await prepare({
    model: 'model',
    input: [{ type: 'reasoning', id: 'rs_client', summary: [{ type: 'summary_text', text: 'visible' }], encrypted_content: carrier }],
  });

  const projectionA = project(prepared, candidateA);
  const projectionB = project(prepared, candidateB);
  const mismatchedProjection = project(prepared, mismatchedRules);
  expect(projectionA.payload.input).toEqual([{
    type: 'reasoning',
    id: 'rs_client',
    summary: [{ type: 'summary_text', text: 'visible' }],
    encrypted_content: 'encrypted',
  }]);
  expect(project(prepared, compatibleModel).payload.input).toEqual(projectionA.payload.input);
  expect(projectionB.payload.input).toEqual([]);
  expect(projectionA.degrades).toBe(false);
  expect(projectionB.degrades).toBe(true);
  expect(mismatchedProjection.degrades).toBe(false);
  expect(select([candidateB, mismatchedRules, compatibleModel, candidateA], prepared)).toEqual([
    candidateA, mismatchedRules, compatibleModel, candidateB,
  ]);
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
  const prepared = await prepare({
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
  });

  const projectionA = project(prepared, candidateA);
  const projectionB = project(prepared, candidateB);
  expect(projectionA.payload.input[0]).toMatchObject({
    id: 'amsg_client',
    content: [
      { type: 'encrypted_content', encrypted_content: 'first' },
      { type: 'encrypted_content', encrypted_content: 'foreign' },
      { type: 'input_text', text: 'visible' },
    ],
  });
  expect(projectionB.payload.input[0]).toMatchObject({
    id: 'amsg_client',
    content: [
      { type: 'encrypted_content', encrypted_content: 'foreign' },
      { type: 'input_text', text: 'visible' },
    ],
  });
  expect(projectionA.degrades).toBe(false);
  expect(projectionB.degrades).toBe(true);
});

test('drops reasoning with a routing-only carrier on a model switch and always removes synthetic items', async () => {
  const incompatibleModel = candidate('upstream-a', 'another-model');
  const syntheticItem = await codec.wrap(
    undefined,
    targetFor(candidateA),
    carrierDomain('reasoning', 'encrypted_content'),
    { syntheticItem: true },
  );
  const routingCarrier = await codec.wrap(
    undefined,
    targetFor(candidateA),
    carrierDomain('reasoning', 'encrypted_content'),
  );
  const foreignReasoning = { type: 'reasoning' as const, id: 'rs_foreign', summary: [], encrypted_content: 'foreign' };
  const userMessage = { type: 'message', role: 'user', content: 'next question' } as const;
  const parsed = canonicalizeOpenAIResponsesPayload({
    model: 'model',
    input: [
      {
        type: 'reasoning',
        summary: [],
        content: null,
        status: 'completed',
        encrypted_content: syntheticItem,
      },
      { type: 'reasoning', id: 'rs_existing', summary: [], encrypted_content: routingCarrier },
      {
        type: 'reasoning',
        id: 'rs_visible',
        summary: [{ type: 'summary_text', text: 'visible' }],
        encrypted_content: routingCarrier,
      },
      foreignReasoning,
      userMessage,
    ],
  });
  if ('error' in parsed) throw new Error(parsed.error.message);
  const prepared = await prepare(parsed);

  const compatibleItems = [
    { type: 'reasoning', id: 'rs_existing', summary: [] },
    {
      type: 'reasoning',
      id: 'rs_visible',
      summary: [{ type: 'summary_text', text: 'visible' }],
    },
    foreignReasoning,
    userMessage,
  ];
  const projectionA = project(prepared, candidateA);
  const incompatible = project(prepared, incompatibleModel);
  expect(projectionA.payload.input).toEqual(compatibleItems);
  expect(incompatible.payload.input).toEqual([foreignReasoning, userMessage]);
  expect(projectionA.degrades).toBe(false);
  expect(incompatible.degrades).toBe(true);
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
  const prepared = await prepare({
    model: 'model',
    input: [
      { type: 'reasoning', id: 'rs_prefix', summary: [], encrypted_content: carrier },
      { type: 'program_output', id: 'prog_out_client', call_id: 'call_1', result: 'done', status: 'completed' },
    ],
  });

  expect(prepared.analysis.requiredTargets).toEqual([targetFor(lastRoutedVariant)]);
  expect(evaluateOpenAIResponsesCandidate(prepared.analysis, candidateB, prepared.payload)).toEqual({ kind: 'rejected' });
  const selection = select([firstVariant, lastRoutedVariant, candidateB], prepared);
  expect(selection).toEqual([
    firstVariant,
    lastRoutedVariant,
  ]);
  const firstEvaluation = project(prepared, firstVariant);
  expect(firstEvaluation.degrades).toBe(false);
  expect(firstEvaluation.payload.input).toEqual([{
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
  const prepared = await prepare({
    model: 'model',
    input: [
      { type: 'reasoning', id: 'rs_prefix', summary: [], encrypted_content: carrier },
      { type: 'program', id: 'prog_client', call_id: 'call_1', code: 'return 1', fingerprint: 'foreign' },
    ],
  });

  expect(prepared.analysis.requiredTargets).toEqual([]);
  expect(project(prepared, candidateA).payload.input[0]).toMatchObject({ fingerprint: 'foreign' });
});
