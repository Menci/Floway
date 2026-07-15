import { describe, expect, test } from 'vitest';

import { affinityTargetForCandidate } from './candidate.ts';
import { prepareChatCompletionsAffinity } from './chat-completions-ingress.ts';
import { AffinityCodec } from './codec.ts';
import { prepareGeminiAffinity } from './gemini-ingress.ts';
import { prepareMessagesAffinity } from './messages-ingress.ts';
import { prepareResponsesAffinity } from './responses-ingress.ts';
import type { ModelCandidate } from '@floway-dev/provider';
import { stubModelCandidate } from '@floway-dev/test-utils';

const codec = new AffinityCodec('22'.repeat(32));

const candidate = (upstream: string): ModelCandidate => {
  const base = stubModelCandidate();
  return stubModelCandidate({
    provider: { ...base.provider, upstream, upstreamRevision: `${upstream}-revision` },
    model: { id: 'model' },
  });
};

const candidateA = candidate('upstream-a');
const candidateB = candidate('upstream-b');

describe('protocol affinity ingress', () => {
  test('Chat Completions restores owned opaque state only for its exact candidate', async () => {
    const carrier = await codec.wrap('upstream-signature', affinityTargetForCandidate(candidateA, 'prefer'));
    const prepared = await prepareChatCompletionsAffinity({
      model: 'model',
      messages: [{ role: 'assistant', content: 'answer', reasoning_opaque: carrier }],
    }, codec);

    expect(prepared.affinities).toEqual([affinityTargetForCandidate(candidateA, 'prefer')]);
    expect(prepared.payloadForCandidate(candidateA).messages[0]).toMatchObject({ reasoning_opaque: 'upstream-signature' });
    expect(prepared.payloadForCandidate(candidateB).messages[0]).not.toHaveProperty('reasoning_opaque');
  });

  test('Messages removes synthetic blocks and strips incompatible signatures without hiding thinking', async () => {
    const signature = await codec.wrap('signature', affinityTargetForCandidate(candidateA, 'prefer'));
    const synthetic = await codec.wrap(undefined, affinityTargetForCandidate(candidateA, 'prefer'));
    const prepared = await prepareMessagesAffinity({
      model: 'model',
      max_tokens: 100,
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'visible reasoning', signature },
          { type: 'redacted_thinking', data: synthetic },
          { type: 'text', text: 'answer' },
        ],
      }],
    }, codec);

    expect(prepared.payloadForCandidate(candidateA).messages[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'visible reasoning', signature: 'signature' },
        { type: 'text', text: 'answer' },
      ],
    });
    expect(prepared.payloadForCandidate(candidateB).messages[0]).toEqual({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'visible reasoning' },
        { type: 'text', text: 'answer' },
      ],
    });
  });

  test('Gemini removes a synthetic signature-only part and preserves foreign signatures', async () => {
    const synthetic = await codec.wrap(undefined, affinityTargetForCandidate(candidateA, 'prefer'));
    const prepared = await prepareGeminiAffinity({
      contents: [{
        role: 'model',
        parts: [
          { text: 'answer' },
          { thoughtSignature: synthetic },
          { text: 'foreign', thoughtSignature: 'not-floway' },
        ],
      }],
    }, codec);

    expect(prepared.payloadForCandidate(candidateA).contents?.[0].parts).toEqual([
      { text: 'answer' },
      { text: 'foreign', thoughtSignature: 'not-floway' },
    ]);
  });

  test('Responses restores the original upstream item id and drops owned state on fallback', async () => {
    const carrier = await codec.wrap('encrypted', affinityTargetForCandidate(candidateA, 'prefer', 'rs_upstream'));
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

  test('foreign blobs pass through unchanged for cascaded gateways', async () => {
    const prepared = await prepareResponsesAffinity({
      model: 'model',
      input: [{ type: 'reasoning', id: 'rs_foreign', summary: [], encrypted_content: 'foreign' }],
    }, codec);

    expect(prepared.affinities).toEqual([]);
    expect(prepared.payloadForCandidate(candidateA).input[0]).toMatchObject({ encrypted_content: 'foreign' });
  });
});
