import { expect, test } from 'vitest';

import { responsesAffinityDomain } from './domain.ts';
import { prepareResponsesAffinity } from './ingress.ts';
import { affinityTargetForCandidate } from '../../shared/affinity/candidate.ts';
import { AffinityCodec } from '../../shared/affinity/codec.ts';
import type { ModelCandidate } from '@floway-dev/provider';
import { stubModelCandidate } from '@floway-dev/test-utils';

const codec = new AffinityCodec('22'.repeat(32));

const candidate = (upstream: string): ModelCandidate => {
  const base = stubModelCandidate();
  return stubModelCandidate({
    provider: { ...base.provider, upstream },
    model: { id: 'model' },
  });
};

const candidateA = candidate('upstream-a');
const candidateB = candidate('upstream-b');

test('restores the original upstream item id and drops owned state on fallback', async () => {
  const carrier = await codec.wrap(
    'encrypted',
    { ...affinityTargetForCandidate(candidateA), upstreamItemId: 'rs_upstream' },
    responsesAffinityDomain('reasoning', 'encrypted_content'),
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
    { ...affinityTargetForCandidate(candidateA), upstreamItemId: 'amsg_upstream' },
    responsesAffinityDomain('agent_message', 'content.1.encrypted_content'),
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

test('passes foreign blobs through unchanged for cascaded gateways', async () => {
  const prepared = await prepareResponsesAffinity({
    model: 'model',
    input: [{ type: 'reasoning', id: 'rs_foreign', summary: [], encrypted_content: 'foreign' }],
  }, codec);

  expect(prepared.routingEvidence).toEqual([]);
  expect(prepared.payloadForCandidate(candidateA).input[0]).toMatchObject({ encrypted_content: 'foreign' });
});

test('derives force routing from program state following a preferred carrier', async () => {
  const carrier = await codec.wrap(
    undefined,
    affinityTargetForCandidate(candidateA),
    responsesAffinityDomain('reasoning', 'encrypted_content'),
  );
  const prepared = await prepareResponsesAffinity({
    model: 'model',
    input: [
      { type: 'reasoning', id: 'rs_prefix', summary: [], encrypted_content: carrier },
      { type: 'program', id: 'prog_1', call_id: 'call_1', code: 'return 1', fingerprint: 'fp' },
    ],
  }, codec);

  expect(prepared.routingEvidence).toEqual([
    { target: affinityTargetForCandidate(candidateA), mode: 'prefer' },
    { target: affinityTargetForCandidate(candidateA), mode: 'force' },
  ]);
});
