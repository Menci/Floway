import { expect, test } from 'vitest';

import { wrapOpenAIResponsesAffinityEgress } from '../../../../../src/data-plane/chat/openai-responses/affinity/egress.ts';
import { analyzeOpenAIResponsesAffinity } from '../../../../../src/data-plane/chat/openai-responses/affinity/ingress.ts';
import { hydrateOpenAIResponsesPayload } from '../../../../../src/data-plane/chat/openai-responses/items/hydrate.ts';
import { wrapOpenAIResponsesClientOutput } from '../../../../../src/data-plane/chat/openai-responses/items/output.ts';
import { createOpenAIResponsesHttpStore } from '../../../../../src/data-plane/chat/openai-responses/items/store.ts';
import { AffinityCodec, selectAffinityCandidates } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { initRepo } from '../../../../../src/repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { TEST_OPENAI_RESPONSES_RETENTION_SECONDS, testOpenAIResponsesStatePolicy } from '../test-policy.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesInputItem, OpenAIResponsesResult, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { stubModelCandidate } from '@floway-dev/test-utils';

const modelCandidate = (upstream: string) => {
  const base = stubModelCandidate();
  return stubModelCandidate({
    provider: { ...base.provider, upstreamId: upstream },
    model: { id: 'model-a' },
  });
};

test('affinity selects the route while item storage preserves the exact emitted id', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  void repo.apiKeys.save({
    id: 'key-a', userId: 1, name: 'OpenAI Responses test key', key: 'raw-responses-test',
    serverSecret: '99'.repeat(32), createdAt: '2026-01-01T00:00:00.000Z',
    upstreamIds: null, deletedAt: null, dumpRetentionSeconds: null,
    openaiResponsesRetentionSeconds: TEST_OPENAI_RESPONSES_RETENTION_SECONDS,
  });
  const candidateA = modelCandidate('upstream-a');
  const candidateB = modelCandidate('upstream-b');
  const codec = new AffinityCodec('22'.repeat(32));
  const store = createOpenAIResponsesHttpStore(testOpenAIResponsesStatePolicy(), Date.now(), true);
  store.beginAttempt(new Map());

  const programOutput = {
    type: 'program_output' as const,
    id: 'prog_out_upstream',
    call_id: 'call_1',
    result: 'done',
    status: 'completed' as const,
  };
  const upstreamResponse: OpenAIResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model-a',
    status: 'completed',
    output: [programOutput],
    error: null,
    incomplete_details: null,
  };
  const source = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.added', output_index: 0, item: programOutput });
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: programOutput });
    yield eventFrame({ type: 'response.completed', response: upstreamResponse });
  };
  const withAffinity = wrapOpenAIResponsesAffinityEgress(source(), {
    codec,
    affinity: { upstreamId: candidateA.provider.upstreamId, modelId: candidateA.model.id },
  });
  const client = wrapOpenAIResponsesClientOutput(withAffinity, {
    store,
    responseId: 'resp_public',
  });

  let clientResponse: OpenAIResponsesResult | undefined;
  for await (const frame of client) {
    if (frame.type === 'event' && frame.event.type === 'response.completed') clientResponse = frame.event.response;
  }
  if (clientResponse === undefined) throw new Error('Expected completed client response');
  const publicProgram = clientResponse.output[1];
  if (publicProgram.type !== 'program_output') throw new Error('Expected program output');
  expect(publicProgram.id).toBe(programOutput.id);

  const input = clientResponse.output as unknown as OpenAIResponsesInputItem[];
  await store.loadInputItems(input, input);
  const hydrated = hydrateOpenAIResponsesPayload({ model: 'model-a', input }, store);
  const affinity = await analyzeOpenAIResponsesAffinity(hydrated.payload, codec);
  expect(affinity.requiredTargets).toEqual([{ upstreamId: candidateA.provider.upstreamId, modelId: candidateA.model.id }]);
  expect(affinity.evaluateCandidate(candidateA)).toMatchObject({ kind: 'accepted', degrades: false });
  expect(affinity.evaluateCandidate(candidateB)).toMatchObject({ kind: 'rejected' });
  const selection = selectAffinityCandidates([candidateB, candidateA], affinity);
  if ('kind' in selection) throw new Error(`Expected affinity selection, received ${selection.kind}`);
  expect(selection.candidates).toEqual([candidateA]);
  expect(selection.payloadFor(candidateA).input).toEqual([programOutput]);
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
  } as unknown as OpenAIResponsesResult;
  const source = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.completed', response });
  };
  let clientResponse: OpenAIResponsesResult | undefined;
  for await (const frame of wrapOpenAIResponsesAffinityEgress(source(), {
    codec,
    affinity: { upstreamId: candidate.provider.upstreamId, modelId: candidate.model.id },
  })) if (frame.type === 'event' && frame.event.type === 'response.completed') clientResponse = frame.event.response;
  if (clientResponse === undefined) throw new Error('Expected completed client response');

  const prepared = await analyzeOpenAIResponsesAffinity({
    model: 'model-a',
    input: clientResponse.output as unknown as OpenAIResponsesInputItem[],
  }, codec);
  const evaluation = prepared.evaluateCandidate(candidate);
  if (evaluation.kind === 'rejected') throw new Error('Expected candidate affinity evaluation to be accepted');
  expect(evaluation.materialize().input).toEqual([empty, natural]);
});

test('compaction_summary carrier authenticates after alias canonicalization without rewriting its id', async () => {
  const candidate = modelCandidate('upstream-a');
  const codec = new AffinityCodec('22'.repeat(32));
  const summary = {
    type: 'compaction_summary',
    id: 'cmp_upstream',
    encrypted_content: 'opaque',
  } as unknown as OpenAIResponsesResult['output'][number];
  const response: OpenAIResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model-a',
    status: 'completed',
    output: [summary],
    error: null,
    incomplete_details: null,
  };
  const source = async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.completed', response });
  };
  let wrapped: string | undefined;
  for await (const frame of wrapOpenAIResponsesAffinityEgress(source(), {
    codec,
    affinity: { upstreamId: candidate.provider.upstreamId, modelId: candidate.model.id },
  })) {
    if (frame.type === 'event' && frame.event.type === 'response.completed') {
      wrapped = (frame.event.response.output[0] as { encrypted_content?: string }).encrypted_content;
    }
  }
  if (wrapped === undefined) throw new Error('Expected wrapped compaction summary');

  const canonical = { type: 'compaction', id: 'cmp_public', encrypted_content: wrapped } as unknown as OpenAIResponsesInputItem;
  const prepared = await analyzeOpenAIResponsesAffinity({ model: 'model-a', input: [canonical] }, codec);
  expect(prepared.requiredTargets).toEqual([{ upstreamId: candidate.provider.upstreamId, modelId: candidate.model.id }]);
  const evaluation = prepared.evaluateCandidate(candidate);
  if (evaluation.kind === 'rejected') throw new Error('Expected candidate affinity evaluation to be accepted');
  expect(evaluation.materialize().input[0]).toMatchObject({
    type: 'compaction',
    id: 'cmp_public',
    encrypted_content: 'opaque',
  });
});
