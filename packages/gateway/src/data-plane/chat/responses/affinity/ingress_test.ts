import { expect, test } from 'vitest';

import { prepareResponsesAffinity } from './ingress.ts';
import { AffinityCodec, type AffinityTarget } from '../../shared/affinity/index.ts';
import type { CanonicalResponsesPayload } from '@floway-dev/protocols/responses';
import type { ModelCandidate } from '@floway-dev/provider';
import { stubModelCandidate } from '@floway-dev/test-utils';

const codec = new AffinityCodec('22'.repeat(32));
const canonicalItemType = (itemType: string): string => itemType === 'compaction_summary' ? 'compaction' : itemType;
const carrierDomain = (itemType: string, slot: string): string => `responses.${canonicalItemType(itemType)}.${slot}`;

const candidate = (upstream: string): ModelCandidate => {
  const base = stubModelCandidate();
  return stubModelCandidate({
    provider: { ...base.provider, upstream },
    model: { id: 'model' },
  });
};

const targetFor = (value: ModelCandidate): AffinityTarget => ({
  upstreamId: value.provider.upstream,
  modelId: value.model.id,
  ...(value.rules !== undefined ? { rules: value.rules } : {}),
});

const candidateA = candidate('upstream-a');
const candidateB = candidate('upstream-b');

test('restores an owned blob only for its exact target without changing item ids', async () => {
  const carrier = await codec.wrap(
    'encrypted',
    targetFor(candidateA),
    carrierDomain('reasoning', 'encrypted_content'),
  );
  const prepared = await prepareResponsesAffinity({
    model: 'model',
    input: [{ type: 'reasoning', id: 'rs_client', summary: [{ type: 'summary_text', text: 'visible' }], encrypted_content: carrier }],
  }, codec);

  expect(prepared.payloadForCandidate(candidateA).input).toEqual([{
    type: 'reasoning',
    id: 'rs_client',
    summary: [{ type: 'summary_text', text: 'visible' }],
    encrypted_content: 'encrypted',
  }]);
  expect(prepared.payloadForCandidate(candidateB).input).toEqual([{
    type: 'reasoning',
    id: 'rs_client',
    summary: [{ type: 'summary_text', text: 'visible' }],
  }]);
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
  const prepared = await prepareResponsesAffinity({
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

  expect(prepared.payloadForCandidate(candidateA).input[0]).toMatchObject({
    id: 'amsg_client',
    content: [
      { type: 'encrypted_content', encrypted_content: 'first' },
      { type: 'encrypted_content', encrypted_content: 'foreign' },
      { type: 'input_text', text: 'visible' },
    ],
  });
  expect(prepared.payloadForCandidate(candidateB).input[0]).toMatchObject({
    id: 'amsg_client',
    content: [
      { type: 'encrypted_content', encrypted_content: 'foreign' },
      { type: 'input_text', text: 'visible' },
    ],
  });
});

test('removes an empty originless reasoning prefix but preserves a reasoning item with visible summary', async () => {
  const carrier = await codec.wrap(
    undefined,
    targetFor(candidateA),
    carrierDomain('reasoning', 'encrypted_content'),
  );
  const prepared = await prepareResponsesAffinity({
    model: 'model',
    input: [
      { type: 'reasoning', id: 'rs_prefix', summary: [], encrypted_content: carrier },
      {
        type: 'reasoning',
        id: 'rs_visible',
        summary: [{ type: 'summary_text', text: 'visible' }],
        encrypted_content: carrier,
      },
    ],
  }, codec);

  expect(prepared.payloadForCandidate(candidateA).input).toEqual([{
    type: 'reasoning',
    id: 'rs_visible',
    summary: [{ type: 'summary_text', text: 'visible' }],
  }]);
});

test('derives force routing from blob-less program state after the turn carrier', async () => {
  const carrier = await codec.wrap(
    undefined,
    targetFor(candidateA),
    carrierDomain('reasoning', 'encrypted_content'),
  );
  const prepared = await prepareResponsesAffinity({
    model: 'model',
    input: [
      { type: 'reasoning', id: 'rs_prefix', summary: [], encrypted_content: carrier },
      { type: 'program_output', id: 'prog_out_client', call_id: 'call_1', result: 'done', status: 'completed' },
    ],
  }, codec);

  expect(prepared.routingEvidence).toEqual([
    { target: targetFor(candidateA), mode: 'prefer' },
    { target: targetFor(candidateA), mode: 'force' },
  ]);
  expect(prepared.payloadForCandidate(candidateA).input).toEqual([{
    type: 'program_output',
    id: 'prog_out_client',
    call_id: 'call_1',
    result: 'done',
    status: 'completed',
  }]);
});

test('does not inherit force through a foreign program blob', async () => {
  const carrier = await codec.wrap(undefined, targetFor(candidateA), carrierDomain('reasoning', 'encrypted_content'));
  const prepared = await prepareResponsesAffinity({
    model: 'model',
    input: [
      { type: 'reasoning', id: 'rs_prefix', summary: [], encrypted_content: carrier },
      { type: 'program', id: 'prog_client', call_id: 'call_1', code: 'return 1', fingerprint: 'foreign' },
    ],
  }, codec);

  expect(prepared.routingEvidence).toEqual([{ target: targetFor(candidateA), mode: 'prefer' }]);
  expect(prepared.payloadForCandidate(candidateA).input[0]).toMatchObject({ fingerprint: 'foreign' });
});

test('treats compaction_summary as force state across alias-rule variants', async () => {
  const carrier = await codec.wrap(
    'opaque',
    targetFor(candidateA),
    carrierDomain('compaction_summary', 'encrypted_content'),
  );
  const item = { type: 'compaction_summary', id: 'cmp_client', encrypted_content: carrier } as unknown as CanonicalResponsesPayload['input'][number];
  const prepared = await prepareResponsesAffinity({ model: 'model', input: [item] }, codec);

  expect(prepared.routingEvidence.map(evidence => evidence.mode)).toEqual(['prefer', 'force']);
  expect(prepared.payloadForCandidate({ ...candidateA, rules: {} }).input[0]).toMatchObject({
    id: 'cmp_client',
    encrypted_content: 'opaque',
  });
});

test('keeps originless context compaction prefer-only while natural encrypted state forces', async () => {
  const synthetic = await codec.wrap(undefined, targetFor(candidateA), carrierDomain('context_compaction', 'encrypted_content'));
  const originlessItem = {
    type: 'context_compaction',
    id: 'ctx_client',
    encrypted_content: synthetic,
  } as unknown as CanonicalResponsesPayload['input'][number];
  const syntheticPrepared = await prepareResponsesAffinity({ model: 'model', input: [originlessItem] }, codec);
  expect(syntheticPrepared.routingEvidence).toEqual([{ target: targetFor(candidateA), mode: 'prefer' }]);

  const natural = await codec.wrap('opaque', targetFor(candidateA), carrierDomain('context_compaction', 'encrypted_content'));
  const naturalPrepared = await prepareResponsesAffinity({
    model: 'model',
    input: [{ ...originlessItem, encrypted_content: natural } as CanonicalResponsesPayload['input'][number]],
  }, codec);
  expect(naturalPrepared.routingEvidence.map(evidence => evidence.mode)).toEqual(['prefer', 'force']);
});
