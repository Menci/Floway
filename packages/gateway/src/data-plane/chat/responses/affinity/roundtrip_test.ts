import { expect, test } from 'vitest';

import { wrapResponsesAffinityEgress } from './egress.ts';
import { prepareResponsesAffinity } from './ingress.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { AffinityCodec } from '../../shared/affinity/index.ts';
import { ResponsesAttemptState } from '../attempt-state.ts';
import { wrapResponsesClientOutput } from '../items/output.ts';
import { createResponsesHttpStore } from '../items/store.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesInputItem, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { stubModelCandidate } from '@floway-dev/test-utils';

test('stored force items recover their original upstream IDs from adjacent client carriers', async () => {
  initRepo(new InMemoryRepo());
  const base = stubModelCandidate();
  const candidate = stubModelCandidate({
    provider: { ...base.provider, upstream: 'upstream-a' },
    model: { id: 'model-a' },
  });
  const codec = new AffinityCodec('22'.repeat(32));
  const programOutput = { type: 'program_output' as const, id: 'prog_out_upstream', call_id: 'call_1', result: 'done', status: 'completed' as const };
  const response: ResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model-a',
    status: 'completed',
    output: [programOutput],
    error: null,
    incomplete_details: null,
  };
  const source = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...programOutput, id: 'prog_out_initial', result: '', status: 'incomplete' },
    });
    yield eventFrame({ type: 'response.output_item.done', output_index: 0, item: programOutput });
    yield eventFrame({ type: 'response.completed', response });
  };
  const affinity = wrapResponsesAffinityEgress(source(), {
    codec,
    affinity: { upstreamId: candidate.provider.upstream, modelId: candidate.model.id },
  });
  const stored = wrapResponsesClientOutput(affinity, {
    store: createResponsesHttpStore('key-a', true),
    attemptState: new ResponsesAttemptState(),
    responseId: 'resp_public',
  });

  let clientResponse: ResponsesResult | undefined;
  const lifecycleItemIds: string[] = [];
  for await (const frame of stored) {
    if (
      frame.type === 'event'
      && (frame.event.type === 'response.output_item.added' || frame.event.type === 'response.output_item.done')
      && frame.event.item.type === 'program_output'
    ) lifecycleItemIds.push(frame.event.item.id);
    if (frame.type === 'event' && frame.event.type === 'response.completed') clientResponse = frame.event.response;
  }
  expect(clientResponse).toBeDefined();
  if (clientResponse === undefined) throw new Error('Expected completed client response');
  expect(new Set(lifecycleItemIds).size).toBe(1);
  expect(clientResponse.output[1].id).not.toBe('prog_out_upstream');

  const prepared = await prepareResponsesAffinity({ model: 'model-a', input: clientResponse.output as unknown as ResponsesInputItem[] }, codec);
  expect(prepared.routingEvidence.map(evidence => evidence.mode)).toEqual(['prefer', 'force']);
  expect(prepared.payloadForCandidate(candidate).input).toEqual([programOutput]);
});

test('an adjacent carrier restores an originally id-less item', async () => {
  initRepo(new InMemoryRepo());
  const base = stubModelCandidate();
  const candidate = stubModelCandidate({
    provider: { ...base.provider, upstream: 'upstream-a' },
    model: { id: 'model-a' },
  });
  const codec = new AffinityCodec('22'.repeat(32));
  const message = {
    type: 'message' as const,
    role: 'assistant' as const,
    status: 'completed' as const,
    content: [{ type: 'output_text' as const, text: 'answer' }],
  };
  const response: ResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model-a',
    status: 'completed',
    output: [message],
    error: null,
    incomplete_details: null,
  };
  const source = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.completed', response });
  };
  const affinity = wrapResponsesAffinityEgress(source(), {
    codec,
    affinity: { upstreamId: candidate.provider.upstream, modelId: candidate.model.id },
  });
  const client = wrapResponsesClientOutput(affinity, {
    store: createResponsesHttpStore('key-a', false),
    attemptState: new ResponsesAttemptState(),
    responseId: 'resp_public',
  });
  let clientResponse: ResponsesResult | undefined;
  for await (const frame of client) {
    if (frame.type === 'event' && frame.event.type === 'response.completed') clientResponse = frame.event.response;
  }
  if (clientResponse === undefined) throw new Error('Expected completed client response');

  const prepared = await prepareResponsesAffinity({ model: 'model-a', input: clientResponse.output as unknown as ResponsesInputItem[] }, codec);
  expect(prepared.payloadForCandidate(candidate).input).toEqual([message]);
});

test('an adjacent carrier accepts Codex-normalized message history', async () => {
  initRepo(new InMemoryRepo());
  const base = stubModelCandidate();
  const candidate = stubModelCandidate({
    provider: { ...base.provider, upstream: 'upstream-a' },
    model: { id: 'model-a' },
  });
  const codec = new AffinityCodec('22'.repeat(32));
  const message = {
    type: 'message' as const,
    id: 'msg_upstream',
    role: 'assistant' as const,
    status: 'completed' as const,
    content: [{ type: 'output_text' as const, text: 'answer', annotations: [], logprobs: [] }],
  };
  const response: ResponsesResult = {
    id: 'resp_upstream',
    object: 'response',
    model: 'model-a',
    status: 'completed',
    output: [message],
    error: null,
    incomplete_details: null,
  };
  const source = async function* (): AsyncIterable<ProtocolFrame<ResponsesStreamEvent>> {
    yield eventFrame({ type: 'response.completed', response });
  };
  const withAffinity = wrapResponsesAffinityEgress(source(), {
    codec,
    affinity: { upstreamId: candidate.provider.upstream, modelId: candidate.model.id },
  });
  let clientResponse: ResponsesResult | undefined;
  for await (const frame of wrapResponsesClientOutput(withAffinity, {
    store: createResponsesHttpStore('key-a', false),
    attemptState: new ResponsesAttemptState(),
    responseId: 'resp_public',
  })) if (frame.type === 'event' && frame.event.type === 'response.completed') clientResponse = frame.event.response;
  if (clientResponse === undefined) throw new Error('Expected completed client response');
  const clientMessage = clientResponse.output[1] as unknown as Record<string, unknown>;
  delete clientMessage.status;
  const [outputText] = clientMessage.content as Array<Record<string, unknown>>;
  outputText.type = 'input_text';
  delete outputText.annotations;
  delete outputText.logprobs;

  const prepared = await prepareResponsesAffinity({ model: 'model-a', input: clientResponse.output as unknown as ResponsesInputItem[] }, codec);
  expect(prepared.payloadForCandidate(candidate).input[0]).toMatchObject({
    type: 'message',
    id: 'msg_upstream',
    content: [{ type: 'input_text', text: 'answer' }],
  });
});

test('agent-message natural and synthetic nested carriers round-trip', async () => {
  const base = stubModelCandidate();
  const candidate = stubModelCandidate({
    provider: { ...base.provider, upstream: 'upstream-a' },
    model: { id: 'model-a' },
  });
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

  const prepared = await prepareResponsesAffinity({ model: 'model-a', input: clientResponse.output as unknown as ResponsesInputItem[] }, codec);
  expect(prepared.payloadForCandidate(candidate).input).toEqual([empty, natural]);
});

test('compaction_summary carrier authenticates after a client canonicalizes its alias', async () => {
  const base = stubModelCandidate();
  const candidate = stubModelCandidate({
    provider: { ...base.provider, upstream: 'upstream-a' },
    model: { id: 'model-a' },
  });
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

  const canonical = {
    type: 'compaction',
    id: 'cmp_public',
    encrypted_content: wrapped,
  } as unknown as ResponsesInputItem;
  const prepared = await prepareResponsesAffinity({ model: 'model-a', input: [canonical] }, codec);
  expect(prepared.routingEvidence.map(evidence => evidence.mode)).toEqual(['prefer', 'force']);
  expect(prepared.payloadForCandidate(candidate).input[0]).toMatchObject({
    type: 'compaction',
    id: 'cmp_upstream',
    encrypted_content: 'opaque',
  });
});
