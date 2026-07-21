import { expect, test } from 'vitest';

import { wrapResponsesAffinityEgress } from './egress.ts';
import { prepareResponsesAffinity, responsesItemIdentity } from './ingress.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { AffinityCodec } from '../../shared/affinity/index.ts';
import { hydrateResponsesPayload } from '../items/hydrate.ts';
import { wrapResponsesClientOutput } from '../items/output.ts';
import { createResponsesHttpStore, createResponsesWsSession } from '../items/store.ts';
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

test('affinity selects the route while item storage preserves the exact producer id', async () => {
  initRepo(new InMemoryRepo());
  const candidateA = modelCandidate('upstream-a');
  const candidateB = modelCandidate('upstream-b');
  const codec = new AffinityCodec('22'.repeat(32));
  const store = createResponsesHttpStore('key-a', true);
  store.beginAttempt(new Map());

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
    producerIdentity: async item => await responsesItemIdentity(item, codec),
  });

  let clientResponse: ResponsesResult | undefined;
  for await (const frame of client) {
    if (frame.type === 'event' && frame.event.type === 'response.completed') clientResponse = frame.event.response;
  }
  if (clientResponse === undefined) throw new Error('Expected completed client response');
  const publicProgram = clientResponse.output[1];
  if (publicProgram.type !== 'program_output') throw new Error('Expected program output');
  expect(publicProgram.id).toBe(programOutput.id);

  const input = clientResponse.output as unknown as ResponsesInputItem[];
  await store.loadInputItems(input, input.map(item => ({ item, stableIdentity: item })));
  const hydrated = hydrateResponsesPayload({ model: 'model-a', input }, store);
  const affinity = await prepareResponsesAffinity(hydrated.payload, codec);
  expect(affinity.routingEvidence.map(evidence => evidence.mode)).toEqual(['prefer', 'force']);

  expect(affinity.payloadForCandidate(candidateA).input).toEqual([programOutput]);
  expect(affinity.payloadForCandidate(candidateB).input).toEqual([programOutput]);
});

test.each(['HTTP store=true', 'WebSocket store=false'] as const)(
  '%s accepts an identical affinity-bearing producer item across turns',
  async mode => {
    const repo = new InMemoryRepo();
    initRepo(repo);
    const candidate = modelCandidate('upstream-a');
    const codec = new AffinityCodec('22'.repeat(32));
    const session = createResponsesWsSession();
    const createStore = () => mode === 'HTTP store=true'
      ? createResponsesHttpStore('key-a', true)
      : session.createStore('key-a', false);
    const item = { type: 'reasoning' as const, id: 'rs_reused', summary: [], encrypted_content: 'opaque' };

    const runTurn = async (): Promise<typeof item> => {
      const response: ResponsesResult = {
        id: 'resp_upstream',
        object: 'response',
        model: 'model-a',
        status: 'completed',
        output: [item],
        error: null,
        incomplete_details: null,
      };
      const source = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
        yield eventFrame({ type: 'response.output_item.added', output_index: 0, item });
        yield eventFrame({ type: 'response.output_item.done', output_index: 0, item });
        yield eventFrame({ type: 'response.completed', response });
      };
      const withAffinity = wrapResponsesAffinityEgress(source(), {
        codec,
        affinity: { upstreamId: candidate.provider.upstream, modelId: candidate.model.id },
      });
      let output: typeof item | undefined;
      for await (const frame of wrapResponsesClientOutput(withAffinity, {
        store: createStore(),
        responseId: 'resp_public',
        producerIdentity: async candidateItem => await responsesItemIdentity(candidateItem, codec),
      })) {
        if (frame.type === 'event' && frame.event.type === 'response.output_item.done') {
          output = frame.event.item as typeof item;
        }
      }
      if (output === undefined) throw new Error('Expected reasoning output');
      return output;
    };

    const first = await runTurn();
    const second = await runTurn();
    expect(second.id).toBe(first.id);
    expect(second.encrypted_content).not.toBe(first.encrypted_content);

    const reader = createStore();
    await reader.loadInputItems([{ type: 'item_reference', id: item.id }], []);
    expect(reader.getItemById(item.id)?.payload.item).toEqual(first);
  },
);

test('one producer id cannot alias different affinity targets', async () => {
  initRepo(new InMemoryRepo());
  const codec = new AffinityCodec('22'.repeat(32));
  const item = { type: 'reasoning' as const, id: 'rs_cross_target', summary: [], encrypted_content: 'opaque' };

  const runTurn = async (candidate: ReturnType<typeof modelCandidate>): Promise<void> => {
    const store = createResponsesHttpStore('key-a', true);
    const response: ResponsesResult = {
      id: 'resp_upstream',
      object: 'response',
      model: candidate.model.id,
      status: 'completed',
      output: [item],
      error: null,
      incomplete_details: null,
    };
    const source = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
      yield eventFrame({ type: 'response.output_item.done', output_index: 0, item });
      yield eventFrame({ type: 'response.completed', response });
    };
    const frames = wrapResponsesAffinityEgress(source(), {
      codec,
      affinity: { upstreamId: candidate.provider.upstream, modelId: candidate.model.id },
    });
    for await (const _frame of wrapResponsesClientOutput(frames, {
      store,
      responseId: 'resp_public',
      producerIdentity: async candidateItem => await responsesItemIdentity(candidateItem, codec),
    })) { /* drain */ }
  };

  await runTurn(modelCandidate('upstream-a'));
  await expect(runTurn(modelCandidate('upstream-b')))
    .rejects.toThrow(`Responses item id collision: ${item.id}`);
});

test.each([true, false])('store=%s accepts fresh affinity ciphertext for a staged producer identity', async storeFlag => {
  initRepo(new InMemoryRepo());
  const codec = new AffinityCodec('22'.repeat(32));
  const target = { upstreamId: 'upstream-a', modelId: 'model-a' };
  const raw = { type: 'reasoning' as const, id: 'rs_staged', summary: [], encrypted_content: 'opaque' };
  const first = {
    ...raw,
    encrypted_content: await codec.wrap(raw.encrypted_content, target, 'responses.reasoning.encrypted_content'),
  };
  const firstIdentity = await responsesItemIdentity(first, codec);
  const store = createResponsesHttpStore('key-a', storeFlag);
  await store.loadInputItems([first], [{ item: first, stableIdentity: firstIdentity.stableIdentity }]);
  await store.stageInputItems([{ item: first, stableIdentity: firstIdentity.stableIdentity }]);
  store.beginAttempt(new Map());

  const second = {
    ...raw,
    encrypted_content: await codec.wrap(raw.encrypted_content, target, 'responses.reasoning.encrypted_content'),
  };
  expect(second.encrypted_content).not.toBe(first.encrypted_content);
  const input = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: second });
  };
  for await (const _frame of wrapResponsesClientOutput(input(), {
    store,
    responseId: 'resp_public',
    producerIdentity: async item => await responsesItemIdentity(item, codec),
  })) { /* drain */ }
});

test.each([true, false])('store=%s rejects a staged producer identity from another affinity target', async storeFlag => {
  initRepo(new InMemoryRepo());
  const codec = new AffinityCodec('22'.repeat(32));
  const raw = { type: 'reasoning' as const, id: 'rs_staged_target', summary: [], encrypted_content: 'opaque' };
  const first = {
    ...raw,
    encrypted_content: await codec.wrap(raw.encrypted_content, { upstreamId: 'upstream-a', modelId: 'model-a' }, 'responses.reasoning.encrypted_content'),
  };
  const firstIdentity = await responsesItemIdentity(first, codec);
  const store = createResponsesHttpStore('key-a', storeFlag);
  await store.loadInputItems([first], [{ item: first, stableIdentity: firstIdentity.stableIdentity }]);
  await store.stageInputItems([{ item: first, stableIdentity: firstIdentity.stableIdentity }]);
  store.beginAttempt(new Map());

  const second = {
    ...raw,
    encrypted_content: await codec.wrap(raw.encrypted_content, { upstreamId: 'upstream-b', modelId: 'model-a' }, 'responses.reasoning.encrypted_content'),
  };
  const input = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: second });
  };
  const collect = async () => {
    for await (const _frame of wrapResponsesClientOutput(input(), {
      store,
      responseId: 'resp_public',
      producerIdentity: async item => await responsesItemIdentity(item, codec),
    })) { /* drain */ }
  };

  await expect(collect()).rejects.toThrow(`Responses item id collision: ${raw.id}`);
});

test('idless affinity-bearing input reuses one storage key across stateful turns', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const codec = new AffinityCodec('22'.repeat(32));
  const target = { upstreamId: 'upstream-a', modelId: 'model-a' };
  const wrapInput = async (): Promise<ResponsesInputItem> => ({
    type: 'context_compaction',
    encrypted_content: await codec.wrap('opaque', target, 'responses.context_compaction.encrypted_content'),
  });
  const stageTurn = async (responseId: string): Promise<string[]> => {
    const item = await wrapInput();
    const identity = await responsesItemIdentity(item, codec);
    const store = createResponsesHttpStore('key-a', true);
    const identified = [{ item, stableIdentity: identity.stableIdentity }];
    await store.loadInputItems([item], identified);
    await store.stageInputItems(identified);
    await store.commitSnapshot(responseId, 'append');
    return (await repo.responsesSnapshots.lookup('key-a', responseId))!.itemIds;
  };

  const first = await stageTurn('resp_first');
  const second = await stageTurn('resp_second');
  expect(second).toEqual(first);
  expect(first).toHaveLength(1);
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
