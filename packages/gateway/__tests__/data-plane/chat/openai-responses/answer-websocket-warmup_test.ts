import { expect, test, vi } from 'vitest';

import { answerOpenAIResponsesWebSocketWarmup } from '../../../../src/data-plane/chat/openai-responses/answer-websocket-warmup.ts';
import { mockChatGatewayCtx } from '../../../test-utils/gateway-ctx.ts';
import { compose, defineStage, move, run } from '@floway-dev/pipeline';
import { doneFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { stubModelCandidate } from '@floway-dev/test-utils';

const exercise = async (generate: boolean | null | undefined) => {
  const candidate = stubModelCandidate();
  const gateway = mockChatGatewayCtx();
  const selectAffinity = vi.fn();
  const dial = vi.fn();
  const ending = defineStage<Record<string, unknown>, Record<string, unknown>>({
    name: 'scriptedWarmupDial',
    return: { provides: ['response.chat.openaiResponses', 'response.chat.openaiResponses.streamedUsage', 'response.usage.billable', 'response.http.headers', 'response.http.body'] },
    execute: async facts => {
      dial();
      return move({ ...facts, 'response.chat.openaiResponses': { kind: 'stream', frames: (async function* () { yield doneFrame(); })() }, 'response.chat.openaiResponses.streamedUsage': null, 'response.usage.billable': [], 'response.http.headers': [], 'response.http.body': null });
    },
  });
  const payload: CanonicalOpenAIResponsesPayload = { model: 'client-model', input: [{ type: 'message', role: 'developer', content: 'Base instructions' }], ...(generate === undefined ? {} : { generate }) };
  const outcome = await run(compose<Record<string, unknown>, Record<string, unknown>>('warmupUnderTest', [answerOpenAIResponsesWebSocketWarmup, ending]), move({
    'request.chat.openaiResponses': payload,
    'route.attempt': { candidateId: 0, upstreamId: candidate.provider.upstreamId, modelId: candidate.model.id, flags: [] },
  }), { gateway, resolveAttempt: () => candidate, selectAffinity } as never);
  const answer = outcome.facts['response.chat.openaiResponses'] as { frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> };
  const frames: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [];
  for await (const frame of answer.frames) frames.push(frame);
  await outcome.drain();
  return { frames, dial, selectAffinity, candidate, gateway, facts: outcome.facts };
};

test('a prewarm completes locally without dispatch timing and preserves its request identity', async () => {
  const { frames, dial, selectAffinity, candidate, gateway, facts } = await exercise(false);
  expect(dial).not.toHaveBeenCalled();
  expect(selectAffinity).toHaveBeenCalledWith(candidate);
  expect(frames.map(frame => frame.type === 'event' ? frame.event.type : frame.type)).toEqual(['response.created', 'response.in_progress', 'response.completed', 'done']);
  const terminal = frames[2];
  expect(terminal).toMatchObject({ type: 'event', event: { response: { model: candidate.model.id, output: [], status: 'completed', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } } });
  expect(gateway.attempt.telemetry).toBeUndefined();
  expect(gateway.attempt.timing.upstreamCallStartedAt).toBeNull();
  expect(facts['response.usage.billable']).toEqual([expect.objectContaining({ quantities: {} })]);
});

for (const generate of [undefined, null, true]) {
  test(`generate:${generate} continues through the normal chain`, async () => {
    const { dial, selectAffinity, frames } = await exercise(generate);
    expect(dial).toHaveBeenCalledOnce();
    expect(selectAffinity).not.toHaveBeenCalled();
    expect(frames).toEqual([doneFrame()]);
  });
}
