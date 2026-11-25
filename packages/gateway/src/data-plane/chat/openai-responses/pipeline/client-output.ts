import { openAIResponsesExit, openAIResponsesFactSpace } from './facts.ts';
import type { OpenAIResponsesServices } from './services.ts';
import { completeInterruptedOpenAIResponses } from './websocket-interrupt.ts';
import { responseHead } from '../../../pipeline/response.ts';
import { openaiInternalErrorPayload } from '../../../shared/openai-errors.ts';
import { transformProtocolFrames } from '../../pipeline/protocol-frames.ts';
import { affinityIdentityForCandidate } from '../../shared/affinity/index.ts';
import { wrapOpenAIResponsesAffinityEgress } from '../affinity/egress.ts';
import { completeOpenAIResponsesCompaction } from '../compaction-resource.ts';
import { syntheticEventsFromCompaction, wrapOpenAIResponsesClientOutput } from '../items/output.ts';
import { createOpenAIResponsesResponseId } from '../response-id.ts';
import { wrapResponseResourceCompletion } from '../response-resource.ts';
import { move } from '@floway-dev/pipeline';
import { collectOpenAIResponsesProtocolEventsToResult } from '@floway-dev/protocols/openai-responses';
import { toInternalDebugError } from '@floway-dev/provider';

const { defineStage } = openAIResponsesFactSpace<OpenAIResponsesServices>();

export const completeOpenAIResponsesClientOutput = defineStage({
  name: 'openaiResponses.client-output',
  through: {
    request: {
      needs: ['request.openaiResponses', 'request.openaiResponsesAction', 'request.delivery', 'request.ws.responseId?', 'serve.candidate'],
      provides: [],
      consumes: [],
    },
    response: { needs: openAIResponsesExit, provides: ['response.http', 'response.openaiResponses'], consumes: [] },
  },
  async execute(facts, scope) {
    const call = scope.next(facts);
    const back = await call;
    const outcome = back['response.openaiResponses'];
    if (outcome.kind === 'error') return back;
    const { request, store } = scope.services.openAIResponsesState(facts['request.openaiResponses']);
    const delivery = facts['request.delivery'];
    if (delivery.kind !== 'openaiResponses') throw new TypeError('OpenAI Responses ingress requires Responses delivery');
    const websocketResponseId = facts['request.ws.responseId'];
    const responseId = websocketResponseId ?? createOpenAIResponsesResponseId();
    const affinity = {
      codec: scope.services.affinityCodec(),
      affinity: affinityIdentityForCandidate(facts['serve.candidate']),
    };
    const statefulOutput = (frames: Parameters<typeof wrapOpenAIResponsesAffinityEgress>[0]) =>
      wrapOpenAIResponsesClientOutput(wrapOpenAIResponsesAffinityEgress(frames, affinity), { store, responseId });

    if (outcome.kind === 'result') {
      if (facts['request.openaiResponsesAction'] !== 'compact') throw new TypeError('OpenAI Responses generation returned a scalar');
      const persisted = await collectOpenAIResponsesProtocolEventsToResult(statefulOutput(syntheticEventsFromCompaction(outcome.result)));
      if (!persisted.ok) {
        const { cause } = persisted.error;
        return {
          ...back,
          'response.http': move(responseHead(502)),
          'response.openaiResponses': move({ kind: 'error', source: 'upstream', error: openaiInternalErrorPayload(toInternalDebugError(cause)), cause } as const),
        };
      }
      const result = completeOpenAIResponsesCompaction(persisted.value, delivery.createdAt);
      return { ...back, 'response.openaiResponses': move({ kind: 'result', result } as const) };
    }

    const stream = scope.wrapStream(outcome.stream, (items, producer) => transformProtocolFrames(items,
      (upstream, failure) => {
        const interrupted = websocketResponseId === undefined ? upstream : completeInterruptedOpenAIResponses(upstream, {
          failure,
          responseId,
          model: request.model,
        });
        return wrapResponseResourceCompletion(statefulOutput(interrupted), {
          request,
          createdAt: delivery.createdAt,
          stored: store.writesState,
        });
      },
      () => { producer.abort(call); }));
    return { ...back, 'response.openaiResponses': move({ kind: 'stream', stream } as const) };
  },
});
