import { expect, test } from 'vitest';

import { wrapResponsesAffinityEgress } from './egress.ts';
import { prepareResponsesAffinity } from './ingress.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import { AffinityCodec, affinityTargetForCandidate } from '../../shared/affinity/index.ts';
import { ResponsesAttemptState } from '../attempt-state.ts';
import { wrapResponsesOutputForStorage } from '../items/output.ts';
import { createResponsesHttpStore } from '../items/store.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
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
    yield eventFrame({ type: 'response.completed', response });
  };
  const affinity = wrapResponsesAffinityEgress(source(), {
    codec,
    affinity: affinityTargetForCandidate(candidate),
  });
  const stored = wrapResponsesOutputForStorage(affinity, {
    store: createResponsesHttpStore('key-a', true),
    attemptState: new ResponsesAttemptState(),
    responseId: 'resp_public',
  });

  let clientResponse: ResponsesResult | undefined;
  for await (const frame of stored) {
    if (frame.type === 'event' && frame.event.type === 'response.completed') clientResponse = frame.event.response;
  }
  expect(clientResponse).toBeDefined();
  if (clientResponse === undefined) throw new Error('Expected completed client response');
  expect(clientResponse.output[1].id).not.toBe('prog_out_upstream');

  const prepared = await prepareResponsesAffinity({ model: 'model-a', input: clientResponse.output }, codec);
  expect(prepared.routingEvidence.map(evidence => evidence.mode)).toEqual(['prefer', 'force']);
  expect(prepared.payloadForCandidate(candidate).input).toEqual([programOutput]);
});
