import { expect, test } from 'vitest';

import { prepareResponsesAffinity } from './ingress.ts';
import { AffinityCodec, type AffinityTarget } from '../../shared/affinity/index.ts';
import { canonicalResponsesItemType, hashResponsesItemBinding } from '../items/format.ts';
import type { CanonicalResponsesPayload } from '@floway-dev/protocols/responses';
import type { ModelCandidate } from '@floway-dev/provider';
import { stubModelCandidate } from '@floway-dev/test-utils';

const codec = new AffinityCodec('22'.repeat(32));
const carrierDomain = (itemType: string, slot: string): string => `responses.${canonicalResponsesItemType(itemType)}.${slot}`;

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

test('restores the original upstream item id and drops owned state on fallback', async () => {
  const carrier = await codec.wrap(
    'encrypted',
    { ...targetFor(candidateA), upstreamItemId: 'rs_upstream' },
    carrierDomain('reasoning', 'encrypted_content'),
  );
  const prepared = await prepareResponsesAffinity({
    model: 'model',
    input: [{ type: 'reasoning', id: 'rs_gateway', summary: [{ type: 'summary_text', text: 'visible' }], encrypted_content: carrier }],
  }, codec);

  expect(prepared.payloadForCandidate(candidateA).input).toEqual([
    { type: 'reasoning', id: 'rs_upstream', summary: [{ type: 'summary_text', text: 'visible' }], encrypted_content: 'encrypted' },
  ]);
  const fallback = prepared.payloadForCandidate(candidateB).input;
  expect(fallback).toHaveLength(1);
  expect(fallback[0]).not.toHaveProperty('encrypted_content');
  expect((fallback[0] as { id?: string }).id).toMatch(/^rs_tmp_/);
});

test('applies item-id provenance from nested encrypted content', async () => {
  const carrier = await codec.wrap(
    'nested-encrypted',
    { ...targetFor(candidateA), upstreamItemId: 'amsg_upstream' },
    carrierDomain('agent_message', 'content.1.encrypted_content'),
  );
  const prepared = await prepareResponsesAffinity({
    model: 'model',
    input: [{
      type: 'agent_message',
      id: 'amsg_gateway',
      author: 'a',
      recipient: 'b',
      content: [
        { type: 'input_text', text: 'visible' },
        { type: 'encrypted_content', encrypted_content: carrier },
      ],
    }],
  }, codec);

  expect(prepared.payloadForCandidate(candidateA).input[0]).toMatchObject({
    id: 'amsg_upstream',
    content: [{ type: 'input_text', text: 'visible' }, { type: 'encrypted_content', encrypted_content: 'nested-encrypted' }],
  });
  expect(prepared.payloadForCandidate(candidateB).input[0]).toMatchObject({
    id: expect.stringMatching(/^amsg_tmp_/),
    content: [{ type: 'input_text', text: 'visible' }],
  });
});

test('preserves an originally empty agent message after removing its synthetic nested carrier', async () => {
  const carrier = await codec.wrap(
    undefined,
    { ...targetFor(candidateA), upstreamItemId: 'amsg_upstream' },
    carrierDomain('agent_message', 'content.0.encrypted_content'),
  );
  const prepared = await prepareResponsesAffinity({
    model: 'model',
    input: [{
      type: 'agent_message',
      id: 'amsg_public',
      author: 'a',
      recipient: 'b',
      content: [{ type: 'encrypted_content', encrypted_content: carrier }],
    }],
  }, codec);

  expect(prepared.payloadForCandidate(candidateA).input).toEqual([{
    type: 'agent_message',
    id: 'amsg_upstream',
    author: 'a',
    recipient: 'b',
    content: [],
  }]);
  expect(prepared.payloadForCandidate(candidateB).input[0]).toMatchObject({
    id: expect.stringMatching(/^amsg_tmp_/),
    content: [],
  });
});

test('rewrites multiple nested encrypted blocks against their original indexes', async () => {
  const first = await codec.wrap(
    'first',
    { ...targetFor(candidateA), upstreamItemId: 'amsg_upstream' },
    carrierDomain('agent_message', 'content.0.encrypted_content'),
  );
  const second = await codec.wrap(
    'second',
    { ...targetFor(candidateA), upstreamItemId: 'amsg_upstream' },
    carrierDomain('agent_message', 'content.1.encrypted_content'),
  );
  const prepared = await prepareResponsesAffinity({
    model: 'model',
    input: [{
      type: 'agent_message',
      id: 'amsg_public',
      author: 'a',
      recipient: 'b',
      content: [
        { type: 'encrypted_content', encrypted_content: first },
        { type: 'encrypted_content', encrypted_content: second },
        { type: 'encrypted_content', encrypted_content: 'foreign' },
        { type: 'input_text', text: 'visible' },
      ],
    }],
  }, codec);

  expect(prepared.payloadForCandidate(candidateB).input[0]).toMatchObject({
    content: [
      { type: 'encrypted_content', encrypted_content: 'foreign' },
      { type: 'input_text', text: 'visible' },
    ],
  });
});

test('passes foreign blobs through unchanged for cascaded gateways', async () => {
  const prepared = await prepareResponsesAffinity({
    model: 'model',
    input: [{ type: 'reasoning', id: 'rs_foreign', summary: [], encrypted_content: 'foreign' }],
  }, codec);

  expect(prepared.routingEvidence).toEqual([]);
  expect(prepared.payloadForCandidate(candidateA).input[0]).toMatchObject({ encrypted_content: 'foreign' });
});

test('derives force routing from blob-less program state following a preferred carrier', async () => {
  const carrier = await codec.wrap(
    undefined,
    targetFor(candidateA),
    carrierDomain('reasoning', 'encrypted_content'),
  );
  const prepared = await prepareResponsesAffinity({
    model: 'model',
    input: [
      { type: 'reasoning', id: 'rs_prefix', summary: [], encrypted_content: carrier },
      { type: 'program_output', id: 'prog_out_1', call_id: 'call_1', result: 'done', status: 'completed' },
    ],
  }, codec);

  expect(prepared.routingEvidence).toEqual([
    { target: targetFor(candidateA), mode: 'prefer' },
    { target: targetFor(candidateA), mode: 'force' },
  ]);
});

test('does not inherit force through a foreign program blob', async () => {
  const carrier = await codec.wrap(
    undefined,
    targetFor(candidateA),
    carrierDomain('reasoning', 'encrypted_content'),
  );
  const prepared = await prepareResponsesAffinity({
    model: 'model',
    input: [
      { type: 'reasoning', id: 'rs_prefix', summary: [], encrypted_content: carrier },
      { type: 'program', id: 'prog_1', call_id: 'call_1', code: 'return 1', fingerprint: 'foreign' },
    ],
  }, codec);

  expect(prepared.routingEvidence).toEqual([{ target: targetFor(candidateA), mode: 'prefer' }]);
  expect(prepared.payloadForCandidate(candidateA).input[1]).toMatchObject({ fingerprint: 'foreign' });
});

test('restores the bound ID of a force item carried by an adjacent synthetic prefix', async () => {
  const item = { type: 'program_output' as const, id: 'prog_out_public', call_id: 'call_1', result: 'done', status: 'completed' as const };
  const carrier = await codec.wrap(
    undefined,
    {
      ...targetFor(candidateA),
      syntheticItem: true,
      boundItem: {
        type: 'program_output',
        upstreamItemId: 'prog_out_upstream',
        contentHash: await hashResponsesItemBinding(item),
      },
    },
    carrierDomain('reasoning', 'encrypted_content'),
  );
  const prepared = await prepareResponsesAffinity({
    model: 'model',
    input: [
      { type: 'reasoning', id: 'rs_prefix', summary: [], encrypted_content: carrier },
      item,
    ],
  }, codec);

  expect(prepared.payloadForCandidate(candidateA).input).toEqual([
    { type: 'program_output', id: 'prog_out_upstream', call_id: 'call_1', result: 'done', status: 'completed' },
  ]);
  expect((prepared.payloadForCandidate(candidateB).input[0] as { id: string }).id).toMatch(/^prog_out_tmp_/);
  expect(prepared.payloadForCandidate({ ...candidateA, rules: {} }).input[0]).toMatchObject({ id: 'prog_out_upstream' });
  expect(prepared.itemIdMapForCandidate(candidateA).get('prog_out_public')).toBe('prog_out_upstream');
  expect(prepared.routingEvidence.map(item => item.mode)).toEqual(['prefer', 'force']);
});

test('restores a preferred bound item ID for no-overlay rules but not an override', async () => {
  const aliasCandidate = { ...candidateA, rules: {} };
  const overriddenCandidate = { ...candidateA, rules: { reasoning: { effort: 'low' as const } } };
  const item = { type: 'message' as const, id: 'msg_public', role: 'assistant' as const, content: 'answer' };
  const carrier = await codec.wrap(
    undefined,
    {
      ...targetFor(aliasCandidate),
      syntheticItem: true,
      boundItem: {
        type: item.type,
        upstreamItemId: 'msg_upstream',
        contentHash: await hashResponsesItemBinding(item),
      },
    },
    carrierDomain('reasoning', 'encrypted_content'),
  );
  const prepared = await prepareResponsesAffinity({
    model: 'model',
    input: [
      { type: 'reasoning', id: 'rs_prefix', summary: [], encrypted_content: carrier },
      item,
    ],
  }, codec);

  expect(prepared.payloadForCandidate(aliasCandidate).input[0]).toMatchObject({ id: 'msg_upstream' });
  expect(prepared.payloadForCandidate(candidateA).input[0]).toMatchObject({ id: 'msg_upstream' });
  expect(prepared.payloadForCandidate(overriddenCandidate).input[0]).toMatchObject({ id: expect.stringMatching(/^msg_tmp_/) });
});

test('rejects a bound carrier moved before a different same-type item', async () => {
  const original = { type: 'program_output' as const, id: 'first_public', call_id: 'call_1', result: 'first', status: 'completed' as const };
  const carrier = await codec.wrap(
    undefined,
    {
      ...targetFor(candidateA),
      syntheticItem: true,
      boundItem: {
        type: original.type,
        upstreamItemId: 'first_upstream',
        contentHash: await hashResponsesItemBinding(original),
      },
    },
    carrierDomain('reasoning', 'encrypted_content'),
  );

  await expect(prepareResponsesAffinity({
    model: 'model',
    input: [
      { type: 'reasoning', id: 'rs_prefix', summary: [], encrypted_content: carrier },
      { type: 'program_output', id: 'second_public', call_id: 'call_2', result: 'second', status: 'completed' },
    ],
  }, codec)).rejects.toMatchObject({
    name: 'ResponsesAffinityInputError',
    message: 'Affinity carrier does not match the Responses input item at index 1.',
    param: 'input[1]',
  });
});

test('treats compaction_summary as force state and restores its upstream ID', async () => {
  const carrier = await codec.wrap(
    'opaque',
    { ...targetFor(candidateA), upstreamItemId: 'cmp_upstream' },
    carrierDomain('compaction_summary', 'encrypted_content'),
  );
  const item = { type: 'compaction_summary', id: 'cmp_public', encrypted_content: carrier } as unknown as CanonicalResponsesPayload['input'][number];
  const prepared = await prepareResponsesAffinity({ model: 'model', input: [item] }, codec);
  const aliasVariant = { ...candidateA, rules: {} };

  expect(prepared.routingEvidence.map(evidence => evidence.mode)).toEqual(['prefer', 'force']);
  expect(prepared.payloadForCandidate(candidateA).input[0]).toMatchObject({ id: 'cmp_upstream', encrypted_content: 'opaque' });
  expect(prepared.payloadForCandidate(aliasVariant).input[0]).toMatchObject({ id: 'cmp_upstream', encrypted_content: 'opaque' });
});

test('keeps synthetic context compaction prefer-only while natural encrypted state forces', async () => {
  const synthetic = await codec.wrap(
    undefined,
    { ...targetFor(candidateA), upstreamItemId: 'ctx_upstream' },
    carrierDomain('context_compaction', 'encrypted_content'),
  );
  const syntheticItem = {
    type: 'context_compaction',
    id: 'ctx_public',
    encrypted_content: synthetic,
  } as unknown as CanonicalResponsesPayload['input'][number];
  const syntheticPrepared = await prepareResponsesAffinity({ model: 'model', input: [syntheticItem] }, codec);
  expect(syntheticPrepared.routingEvidence).toEqual([{ target: { ...targetFor(candidateA), upstreamItemId: 'ctx_upstream' }, mode: 'prefer' }]);

  const natural = await codec.wrap(
    'opaque',
    { ...targetFor(candidateA), upstreamItemId: 'ctx_upstream' },
    carrierDomain('context_compaction', 'encrypted_content'),
  );
  const naturalItem = { ...syntheticItem, encrypted_content: natural } as unknown as CanonicalResponsesPayload['input'][number];
  const naturalPrepared = await prepareResponsesAffinity({ model: 'model', input: [naturalItem] }, codec);
  expect(naturalPrepared.routingEvidence.map(evidence => evidence.mode)).toEqual(['prefer', 'force']);
  expect(naturalPrepared.payloadForCandidate({ ...candidateA, rules: {} }).input[0]).toMatchObject({
    id: 'ctx_upstream',
    encrypted_content: 'opaque',
  });
});
