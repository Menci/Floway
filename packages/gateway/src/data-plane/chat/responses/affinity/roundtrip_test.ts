import { expect, test } from 'vitest';

import { wrapResponsesAffinityEgress } from './egress.ts';
import { prepareResponsesAffinity } from './ingress.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { AffinityCodec } from '../../shared/affinity/index.ts';
import { wrapResponsesClientOutput } from '../items/output.ts';
import { hydrateResponsesPayload, rewriteResponsesItemsForCandidate } from '../items/rewrite.ts';
import { createResponsesHttpStore } from '../items/store.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesInputItem, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { stubModelCandidate } from '@floway-dev/test-utils';

const modelCandidate = (upstream: string) => {
  const base = stubModelCandidate();
  return stubModelCandidate({
    provider: { ...base.provider, upstream },
    model: { id: 'model-a' },
  });
};

test('affinity selects the route while item storage independently restores the native upstream id', async () => {
  initRepo(new InMemoryRepo());
  const candidateA = modelCandidate('upstream-a');
  const candidateB = modelCandidate('upstream-b');
  const codec = new AffinityCodec('22'.repeat(32));
  const store = createResponsesHttpStore('key-a', true);
  store.beginAttempt(new Map(), { upstreamId: 'upstream-a', restoresItemIds: true });

  const programOutput = {
    type: 'program_output' as const,
    id: 'prog_out_upstream',
    call_id: 'call_1',
    result: 'done',
    status: 'completed' as const,
  };
  const upstreamResponse: ResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model-a',
    status: 'completed',
    output: [programOutput],
    error: null,
    incomplete_details: null,
  };
  const source = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.added', output_index: 0, item: programOutput });
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: programOutput });
    yield eventFrame({ type: 'response.completed', response: upstreamResponse });
  };
  const withAffinity = wrapResponsesAffinityEgress(source(), {
    codec,
    affinity: { upstreamId: candidateA.provider.upstream, modelId: candidateA.model.id },
  });
  const client = wrapResponsesClientOutput(withAffinity, {
    store,
    responseId: 'resp_public',
  });

  let clientResponse: ResponsesResult | undefined;
  for await (const frame of client) {
    if (frame.type === 'event' && frame.event.type === 'response.completed') clientResponse = frame.event.response;
  }
  if (clientResponse === undefined) throw new Error('Expected completed client response');
  const publicProgram = clientResponse.output[1];
  if (publicProgram.type !== 'program_output') throw new Error('Expected program output');
  expect(publicProgram.id).not.toBe(programOutput.id);

  const input = clientResponse.output as unknown as ResponsesInputItem[];
  await store.loadInputItems(input, input);
  const hydrated = hydrateResponsesPayload({ model: 'model-a', input }, store);
  const affinity = await prepareResponsesAffinity(hydrated.payload, codec);
  expect(affinity.routingEvidence.map(evidence => evidence.mode)).toEqual(['prefer', 'force']);

  const sameUpstream = rewriteResponsesItemsForCandidate(
    affinity.payloadForCandidate(candidateA),
    hydrated.privatePayloads,
    store,
    candidateA,
  );
  expect(sameUpstream.payload.input).toEqual([programOutput]);

  const otherUpstream = rewriteResponsesItemsForCandidate(
    affinity.payloadForCandidate(candidateB),
    hydrated.privatePayloads,
    store,
    candidateB,
  );
  expect(otherUpstream.payload.input).toEqual([publicProgram]);
});

test('agent-message natural and originless nested carriers round-trip without changing ids', async () => {
  const candidate = modelCandidate('upstream-a');
  const codec = new AffinityCodec('22'.repeat(32));
  const empty = { type: 'agent_message' as const, id: 'amsg_empty', author: 'a', recipient: 'b', content: [] };
  const natural = {
    type: 'agent_message' as const,
    id: 'amsg_natural',
    author: 'a',
    recipient: 'b',
    content: [{ type: 'encrypted_content' as const, encrypted_content: 'opaque' }],
  };
  const response = {
    id: 'resp_upstream',
    object: 'response' as const,
    model: 'model-a',
    status: 'completed' as const,
    output: [empty, natural],
    error: null,
    incomplete_details: null,
  } as unknown as ResponsesResult;
  const source = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.completed', response });
  };
  let clientResponse: ResponsesResult | undefined;
  for await (const frame of wrapResponsesAffinityEgress(source(), {
    codec,
    affinity: { upstreamId: candidate.provider.upstream, modelId: candidate.model.id },
  })) if (frame.type === 'event' && frame.event.type === 'response.completed') clientResponse = frame.event.response;
  if (clientResponse === undefined) throw new Error('Expected completed client response');

  const prepared = await prepareResponsesAffinity({
    model: 'model-a',
    input: clientResponse.output as unknown as ResponsesInputItem[],
  }, codec);
  expect(prepared.payloadForCandidate(candidate).input).toEqual([empty, natural]);
});

test('compaction_summary carrier authenticates after alias canonicalization without rewriting its id', async () => {
  const candidate = modelCandidate('upstream-a');
  const codec = new AffinityCodec('22'.repeat(32));
  const summary = {
    type: 'compaction_summary',
    id: 'cmp_upstream',
    encrypted_content: 'opaque',
  } as unknown as ResponsesResult['output'][number];
  const response: ResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model-a',
    status: 'completed',
    output: [summary],
    error: null,
    incomplete_details: null,
  };
  const source = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.completed', response });
  };
  let wrapped: string | undefined;
  for await (const frame of wrapResponsesAffinityEgress(source(), {
    codec,
    affinity: { upstreamId: candidate.provider.upstream, modelId: candidate.model.id },
  })) {
    if (frame.type === 'event' && frame.event.type === 'response.completed') {
      wrapped = (frame.event.response.output[0] as { encrypted_content?: string }).encrypted_content;
    }
  }
  if (wrapped === undefined) throw new Error('Expected wrapped compaction summary');

  const canonical = { type: 'compaction', id: 'cmp_public', encrypted_content: wrapped } as unknown as ResponsesInputItem;
  const prepared = await prepareResponsesAffinity({ model: 'model-a', input: [canonical] }, codec);
  expect(prepared.routingEvidence.map(evidence => evidence.mode)).toEqual(['prefer', 'force']);
  expect(prepared.payloadForCandidate(candidate).input[0]).toMatchObject({
    type: 'compaction',
    id: 'cmp_public',
    encrypted_content: 'opaque',
  });
});
