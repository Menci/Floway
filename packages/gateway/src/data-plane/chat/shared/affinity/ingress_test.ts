import { describe, expect, test } from 'vitest';

import { affinityTargetForCandidate } from './candidate.ts';
import { CHAT_COMPLETIONS_AFFINITY_DOMAIN, GEMINI_AFFINITY_DOMAIN, MESSAGES_REDACTED_AFFINITY_DOMAIN, MESSAGES_SIGNATURE_AFFINITY_DOMAIN, responsesAffinityDomain } from './carrier-domains.ts';
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
    provider: { ...base.provider, upstream },
    model: { id: 'model' },
  });
};

const candidateA = candidate('upstream-a');
const candidateB = candidate('upstream-b');

describe('affinity ingress across source protocols', () => {
  test('Chat Completions restores owned opaque state only for its exact candidate', async () => {
    const carrier = await codec.wrap('upstream-signature', affinityTargetForCandidate(candidateA), CHAT_COMPLETIONS_AFFINITY_DOMAIN);
    const prepared = await prepareChatCompletionsAffinity({
      model: 'model',
      messages: [{ role: 'assistant', content: 'answer', reasoning_opaque: carrier }],
    }, codec);

    expect(prepared.affinities).toEqual([affinityTargetForCandidate(candidateA)]);
    expect(prepared.payloadForCandidate(candidateA).messages[0]).toMatchObject({ reasoning_opaque: 'upstream-signature' });
    expect(prepared.payloadForCandidate(candidateB).messages[0]).not.toHaveProperty('reasoning_opaque');
  });

  test('Messages removes synthetic blocks and strips incompatible signatures without hiding thinking', async () => {
    const signature = await codec.wrap('signature', affinityTargetForCandidate(candidateA), MESSAGES_SIGNATURE_AFFINITY_DOMAIN);
    const synthetic = await codec.wrap(undefined, affinityTargetForCandidate(candidateA), MESSAGES_REDACTED_AFFINITY_DOMAIN);
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
    const synthetic = await codec.wrap(undefined, affinityTargetForCandidate(candidateA), GEMINI_AFFINITY_DOMAIN);
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

  test('Gemini preserves unrelated empty model contents', async () => {
    const prepared = await prepareGeminiAffinity({
      contents: [{ role: 'model', parts: [] }],
    }, codec);

    expect(prepared.payloadForCandidate(candidateA).contents).toEqual([{ role: 'model', parts: [] }]);
  });

  test('Gemini reattaches a deferred wrapped signature to its original visible part', async () => {
    const carrier = await codec.wrap('signature', {
      ...affinityTargetForCandidate(candidateA),
      geminiPartFromEnd: 1,
    }, GEMINI_AFFINITY_DOMAIN);
    const prepared = await prepareGeminiAffinity({
      contents: [
        { role: 'model', parts: [{ functionCall: { name: 'tool', args: {} } }] },
        { role: 'model', parts: [{ thoughtSignature: carrier }] },
      ],
    }, codec);

    expect(prepared.payloadForCandidate(candidateA).contents).toEqual([{
      role: 'model',
      parts: [{ functionCall: { name: 'tool', args: {} }, thoughtSignature: 'signature' }],
    }]);
    expect(prepared.payloadForCandidate(candidateB).contents).toEqual([{
      role: 'model',
      parts: [{ functionCall: { name: 'tool', args: {} } }],
    }]);
  });

  test('Responses restores the original upstream item id and drops owned state on fallback', async () => {
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

  test('Responses applies item-id provenance from nested encrypted content', async () => {
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

  test('foreign blobs pass through unchanged for cascaded gateways', async () => {
    const prepared = await prepareResponsesAffinity({
      model: 'model',
      input: [{ type: 'reasoning', id: 'rs_foreign', summary: [], encrypted_content: 'foreign' }],
    }, codec);

    expect(prepared.affinities).toEqual([]);
    expect(prepared.payloadForCandidate(candidateA).input[0]).toMatchObject({ encrypted_content: 'foreign' });
  });
});
