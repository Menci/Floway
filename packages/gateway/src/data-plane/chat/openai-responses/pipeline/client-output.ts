import { openAIResponsesExit, openAIResponsesFactSpace } from './facts.ts';
import type { OpenAIResponsesServices } from './services.ts';
import { readProtocolFrames } from '../../pipeline/protocol-frames.ts';
import { affinityIdentityForCandidate } from '../../shared/affinity/index.ts';
import { wrapOpenAIResponsesAffinityEgress } from '../affinity/egress.ts';
import { completeOpenAIResponsesCompaction } from '../compaction-resource.ts';
import { syntheticEventsFromCompaction, wrapOpenAIResponsesClientOutput } from '../items/output.ts';
import { createOpenAIResponsesResponseId } from '../response-id.ts';
import { wrapResponseResourceCompletion } from '../response-resource.ts';
import { move } from '@floway-dev/pipeline';
import { collectOpenAIResponsesProtocolEventsToResult } from '@floway-dev/protocols/openai-responses';

const { defineStage } = openAIResponsesFactSpace<OpenAIResponsesServices>();

export const completeOpenAIResponsesClientOutput = defineStage({
  name: 'openaiResponses.client-output',
  through: {
    request: {
      needs: ['request.openaiResponses', 'request.openaiResponsesAction', 'request.delivery', 'request.ws.responseId?', 'serve.candidate'],
      provides: [],
      consumes: [],
    },
    response: { needs: openAIResponsesExit, provides: ['response.openaiResponses'], consumes: [] },
  },
  async execute(facts, scope) {
    const call = scope.next(facts);
    const back = await call;
    const outcome = back['response.openaiResponses'];
    if (outcome.kind === 'error') return back;
    const { request, store } = scope.services.openAIResponsesState(facts['request.openaiResponses']);
    const delivery = facts['request.delivery'];
    if (delivery.kind !== 'openaiResponses') throw new TypeError('OpenAI Responses ingress requires Responses delivery');
    const responseId = facts['request.ws.responseId'] ?? createOpenAIResponsesResponseId();
    const affinity = {
      codec: scope.services.affinityCodec(),
      affinity: affinityIdentityForCandidate(facts['serve.candidate']),
    };
    const statefulOutput = (frames: Parameters<typeof wrapOpenAIResponsesAffinityEgress>[0]) =>
      wrapOpenAIResponsesClientOutput(wrapOpenAIResponsesAffinityEgress(frames, affinity), { store, responseId });

    if (outcome.kind === 'result') {
      if (facts['request.openaiResponsesAction'] !== 'compact') throw new TypeError('OpenAI Responses generation returned a scalar');
      const persisted = await collectOpenAIResponsesProtocolEventsToResult(statefulOutput(syntheticEventsFromCompaction(outcome.result)));
      const result = completeOpenAIResponsesCompaction(persisted, delivery.createdAt);
      return { ...back, 'response.openaiResponses': move({ kind: 'result', result } as const) };
    }

    const stream = scope.wrapStream(outcome.stream, async function* (items, producer) {
      const source = readProtocolFrames(items);
      let failure;
      try {
        const frames = wrapResponseResourceCompletion(statefulOutput(source.frames()), {
          request,
          createdAt: delivery.createdAt,
          stored: store.writesState,
        });
        for await (const frame of frames) {
          if (frame.type === 'event') yield { ok: true, value: frame.event };
        }
      } catch (cause) {
        failure = cause === source.failure ? source.failure : { kind: 'protocol' as const, cause };
      }
      if (!source.done) producer.abort(call);
      if (failure !== undefined) yield { ok: false, error: failure };
      await source.drain();
    });
    return { ...back, 'response.openaiResponses': move({ kind: 'stream', stream } as const) };
  },
});
