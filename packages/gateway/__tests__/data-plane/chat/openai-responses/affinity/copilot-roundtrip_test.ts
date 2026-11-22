import { expect, test } from 'vitest';

import { wrapOpenAIResponsesAffinityEgress } from '../../../../../src/data-plane/chat/openai-responses/affinity/egress.ts';
import { analyzeOpenAIResponsesAffinity } from '../../../../../src/data-plane/chat/openai-responses/affinity/ingress.ts';
import { AffinityCodec } from '../../../../../src/data-plane/chat/shared/affinity/index.ts';
import { stubRouteCandidate } from '../../../../test-utils/chat-pipeline.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesOutputItemEx, OpenAIResponsesResultEx, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

const candidate = stubRouteCandidate({ upstreamId: 'up-copilot', kind: 'copilot', modelId: 'gpt-test', upstreamModelId: 'gpt-test', endpoints: { openaiResponses: {} }, opaqueBlobCompatibilityScope: { bindToUpstream: true, key: 'up-copilot' } });
const otherCandidate = stubRouteCandidate({ upstreamId: 'up-other', modelId: 'gpt-test', upstreamModelId: 'gpt-test', endpoints: { openaiResponses: {} } });

const response = (output: OpenAIResponsesOutputItemEx[], status: OpenAIResponsesResultEx['status']): OpenAIResponsesResultEx => ({
  id: 'resp_raw', object: 'response', model: 'gpt-test', output, status, error: null, incomplete_details: null,
});

const source = (events: OpenAIResponsesStreamEventEx[]): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> => (async function* () {
  for (const event of events) yield eventFrame(event);
})();

test('Copilot item ids compose with generic affinity trailers and restore in boundary order', async () => {
  const codec = new AffinityCodec('00'.repeat(32));
  const raw: OpenAIResponsesOutputItemEx = { type: 'reasoning', id: 'rs_raw', summary: [], encrypted_content: 'opaque reasoning' };
  const completed = response([raw], 'completed');
  const publicEvents: OpenAIResponsesStreamEventEx[] = [];
  for await (const frame of wrapOpenAIResponsesAffinityEgress(source([
    { type: 'response.created', response: response([], 'in_progress') },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_added', summary: [] } },
    { type: 'response.output_item.done', output_index: 0, item: raw },
    { type: 'response.completed', response: completed },
  ]), { codec, affinity: { upstreamId: candidate.upstreamId, modelId: candidate.modelId, opaqueBlobCompatibilityIdentity: { upstreamId: candidate.upstreamId, key: candidate.upstreamId } } })) {
    if (frame.type === 'event') publicEvents.push(frame.event);
  }
  const done = publicEvents.find(event => event.type === 'response.output_item.done');
  if (done?.type !== 'response.output_item.done') throw new Error('missing done item');
  expect(done.item.id).toBe('rs_raw');
  if (done.item.type !== 'reasoning') throw new Error('expected reasoning item');
  expect(done.item.encrypted_content).not.toBe('opaque reasoning');

  const payload: CanonicalOpenAIResponsesPayload = { model: 'gpt-test', input: [done.item] };
  const prepared = await analyzeOpenAIResponsesAffinity(payload, codec);
  const exact = prepared.evaluateCandidate(candidate);
  const foreign = prepared.evaluateCandidate(otherCandidate);
  if (exact.kind !== 'accepted' || foreign.kind !== 'accepted') throw new Error('expected accepted candidates');
  expect(exact.materialize().input[0]).toMatchObject({ type: 'reasoning', id: done.item.id, encrypted_content: 'opaque reasoning' });
  expect(foreign.materialize().input[0]).toEqual({ type: 'reasoning', id: done.item.id, summary: [] });
});
