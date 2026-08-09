import { describe, expect, test } from 'vitest';

import { wrapResponsesAffinityEgress } from '../../../../../src/data-plane/chat/responses/affinity/egress.ts';
import { analyzeResponsesAffinity } from '../../../../../src/data-plane/chat/responses/affinity/ingress.ts';
import {
  responsesOpaqueLocations,
  responsesSyntheticCarrierSlot,
} from '../../../../../src/data-plane/chat/responses/affinity/opaque-locations.ts';
import { AffinityCodec } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesInputItem, ResponsesOutputItem, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { stubModelCandidate } from '@floway-dev/test-utils';

// The complete carrier inventory. A slot dropped from `opaque-locations.ts`
// strands every carrier already replayed from client history: unscanned on
// ingress means unwrapped, so our own trailer reaches the upstream. Adding a
// carrier slot means adding a row here. `bare` is the same item before the
// upstream supplied an opaque value, which is what decides where — and whether
// — we may grow a carrier of our own.
const CARRIERS = [
  {
    name: 'reasoning',
    item: { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque-reasoning' },
    bare: { type: 'reasoning', id: 'rs_1', summary: [] },
    slots: ['encrypted_content'],
    domains: ['responses.reasoning.encrypted_content'],
    syntheticSlot: 'encrypted_content',
  },
  {
    name: 'compaction',
    item: { type: 'compaction', id: 'cmp_1', encrypted_content: 'opaque-compaction' },
    bare: { type: 'compaction', id: 'cmp_1' },
    slots: ['encrypted_content'],
    domains: ['responses.compaction.encrypted_content'],
    syntheticSlot: 'encrypted_content',
  },
  {
    name: 'compaction_summary',
    item: { type: 'compaction_summary', id: 'cms_1', encrypted_content: 'opaque-summary' },
    bare: { type: 'compaction_summary', id: 'cms_1' },
    slots: ['encrypted_content'],
    // The summary shares the compaction domain so a canonicalized replay still authenticates.
    domains: ['responses.compaction.encrypted_content'],
    syntheticSlot: 'encrypted_content',
  },
  {
    name: 'context_compaction',
    item: { type: 'context_compaction', id: 'ctx_1', encrypted_content: 'opaque-context' },
    bare: { type: 'context_compaction', id: 'ctx_1' },
    slots: ['encrypted_content'],
    domains: ['responses.context_compaction.encrypted_content'],
    syntheticSlot: 'encrypted_content',
  },
  {
    name: 'program',
    item: { type: 'program', id: 'prg_1', call_id: 'call_1', source: 'print(1)', status: 'completed', fingerprint: 'opaque-fingerprint' },
    bare: { type: 'program', id: 'prg_1', call_id: 'call_1', source: 'print(1)', status: 'completed' },
    slots: ['fingerprint'],
    domains: ['responses.program.fingerprint'],
    syntheticSlot: 'fingerprint',
  },
  {
    name: 'agent_message',
    item: {
      type: 'agent_message',
      id: 'amsg_1',
      author: 'a',
      recipient: 'b',
      content: [
        { type: 'text', text: 'visible' },
        { type: 'encrypted_content', encrypted_content: 'opaque-agent-message' },
      ],
    },
    bare: {
      type: 'agent_message',
      id: 'amsg_1',
      author: 'a',
      recipient: 'b',
      content: [{ type: 'text', text: 'visible' }],
    },
    slots: ['content.1.encrypted_content'],
    domains: ['responses.agent_message.content.1.encrypted_content'],
    syntheticSlot: 'content.1.encrypted_content',
  },
  {
    name: 'function_call_output',
    item: {
      type: 'function_call_output',
      id: 'fco_1',
      call_id: 'call_1',
      output: [
        { type: 'input_text', text: 'visible' },
        { type: 'encrypted_content', encrypted_content: 'opaque-function-output' },
      ],
    },
    bare: {
      type: 'function_call_output',
      id: 'fco_1',
      call_id: 'call_1',
      output: [{ type: 'input_text', text: 'visible' }],
    },
    slots: ['output.1.encrypted_content'],
    domains: ['responses.function_call_output.output.1.encrypted_content'],
    // A tool output is the upstream's own structured result, never a slot we grow.
    syntheticSlot: undefined,
  },
  {
    name: 'custom_tool_call_output',
    item: {
      type: 'custom_tool_call_output',
      id: 'cco_1',
      call_id: 'call_1',
      output: [{ type: 'encrypted_content', encrypted_content: 'opaque-custom-output' }],
    },
    bare: { type: 'custom_tool_call_output', id: 'cco_1', call_id: 'call_1', output: [] },
    slots: ['output.0.encrypted_content'],
    domains: ['responses.custom_tool_call_output.output.0.encrypted_content'],
    syntheticSlot: undefined,
  },
] as const;

const candidateFor = (upstreamId: string) => {
  const base = stubModelCandidate();
  return stubModelCandidate({ provider: { ...base.provider, upstreamId }, model: { id: 'model-a' } });
};

const pinned = candidateFor('upstream-a');
const other = candidateFor('upstream-b');
const affinity = { upstreamId: pinned.provider.upstreamId, modelId: pinned.model.id };

const completedResponse = (output: readonly ResponsesOutputItem[]): ResponsesResult => ({
  id: 'resp_upstream',
  object: 'response',
  model: 'model-a',
  status: 'completed',
  output: output as ResponsesResult['output'],
  error: null,
  incomplete_details: null,
});

// A carrier item carries affinity in one of its own slots, so egress must never
// prepend a synthetic reasoning item to hold it.
const throughEgress = async (codec: AffinityCodec, item: unknown): Promise<ResponsesOutputItem> => {
  const source = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.completed', response: completedResponse([item as ResponsesOutputItem]) });
  };
  for await (const frame of wrapResponsesAffinityEgress(source(), { codec, affinity })) {
    if (frame.type !== 'event' || frame.event.type !== 'response.completed') continue;
    const output = frame.event.response.output;
    expect(output).toHaveLength(1);
    return output[0];
  }
  throw new Error('Expected a completed response from affinity egress');
};

const materializedInput = async (
  codec: AffinityCodec,
  input: readonly ResponsesInputItem[],
  candidate: typeof pinned,
): Promise<readonly ResponsesInputItem[] | 'rejected'> => {
  const analysis = await analyzeResponsesAffinity({ model: 'model-a', input: [...input] }, codec);
  const evaluation = analysis.evaluateCandidate(candidate);
  return evaluation.kind === 'rejected' ? 'rejected' : evaluation.materialize().input;
};

describe('Responses affinity carrier slots', () => {
  test.each(CARRIERS)('$name exposes its carrier slots to reading and growing', ({ item, bare, slots, domains, syntheticSlot }) => {
    const locations = responsesOpaqueLocations(item as unknown as ResponsesOutputItem);
    expect(locations.map(location => location.key)).toEqual(slots);
    expect(locations.map(location => location.domain)).toEqual(domains);
    expect(responsesSyntheticCarrierSlot(bare as unknown as ResponsesOutputItem)?.key).toBe(syntheticSlot);
  });

  test.each(CARRIERS)('$name is wrapped on egress and restored on ingress', async ({ item, slots }) => {
    const codec = new AffinityCodec('22'.repeat(32));
    const wrapped = await throughEgress(codec, item);

    // Without this the round trip below passes vacuously whenever egress stops
    // recognizing the slot: an unwrapped value also survives unchanged.
    const wrappedLocations = responsesOpaqueLocations(wrapped);
    expect(wrappedLocations.map(location => location.key)).toEqual(slots);
    const original = responsesOpaqueLocations(item as unknown as ResponsesOutputItem);
    for (const [index, location] of wrappedLocations.entries()) {
      expect(location.value).not.toBe(original[index].value);
    }

    const restored = await materializedInput(codec, [wrapped as unknown as ResponsesInputItem], pinned);
    expect(restored).toEqual([item]);
  });

  test.each(CARRIERS)('$name never hands our trailer to another upstream', async ({ item }) => {
    const codec = new AffinityCodec('22'.repeat(32));
    const wrapped = await throughEgress(codec, item);
    const trailers = responsesOpaqueLocations(wrapped).map(location => location.value);

    const projected = await materializedInput(codec, [wrapped as unknown as ResponsesInputItem], other);
    if (projected === 'rejected') return;
    for (const trailer of trailers) expect(JSON.stringify(projected)).not.toContain(trailer);
  });

  test.each(CARRIERS.filter(carrier => carrier.syntheticSlot !== undefined))(
    '$name grows a synthetic carrier that reaches no upstream',
    async ({ bare, syntheticSlot }) => {
      const codec = new AffinityCodec('22'.repeat(32));
      const grown = await throughEgress(codec, bare);
      expect(responsesOpaqueLocations(grown).map(location => location.key)).toEqual([syntheticSlot]);

      for (const candidate of [pinned, other]) {
        const projected = await materializedInput(codec, [grown as unknown as ResponsesInputItem], candidate);
        if (projected === 'rejected') continue;
        expect(projected).toEqual([bare]);
      }
    },
  );
});
