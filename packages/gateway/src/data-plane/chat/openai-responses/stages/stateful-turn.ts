import { jsonHttpResponse } from '../../../pipeline/edge-http.ts';
import type { SelectedAttemptResponse } from '../../../pipeline/failover.ts';
import { emptyUsageFacts, usageResponseKeys } from '../../../pipeline/observe-usage.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { affinityIdentityForCandidate } from '../../shared/affinity/selection.ts';
import type { DeliveryFacts } from '../../shared/encode.ts';
import { tryCatchChatServeFailure } from '../../shared/errors.ts';
import { wrapOpenAIResponsesAffinityEgress } from '../affinity/egress.ts';
import type { ResponsesDelivery } from '../encode.ts';
import type { OpenAIResponsesServeFailure } from '../errors.ts';
import { hydrateOpenAIResponsesPayload } from '../items/hydrate.ts';
import { syntheticEventsFromCompaction, wrapOpenAIResponsesClientOutput } from '../items/output.ts';
import { expandPreviousResponseId, PreviousResponseNotFoundError } from '../items/previous-response.ts';
import type { OpenAIResponsesStatefulStore } from '../items/store.ts';
import { OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE } from '../response-headers.ts';
import { createOpenAIResponsesResponseId } from '../response-id.ts';
import { wrapResponseResourceCompletion } from '../response-resource.ts';
import type { ResponsesBodyBack } from './facts.ts';
import { defineStage, type StageEnv } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

type Request = DeliveryFacts<ResponsesDelivery> & {
  readonly 'request.openaiResponses': CanonicalOpenAIResponsesPayload;
};
export type ResponsesTurnBack = Omit<ResponsesBodyBack, 'response.openaiResponses'> & Partial<Pick<ResponsesBodyBack, 'response.openaiResponses'>> &
  Partial<Pick<SelectedAttemptResponse, 'response.route.candidate'>>;

const previousNotFound = (id: string) => ({
  error: {
    message: `Previous response with id '${id}' not found.`,
    type: 'invalid_request_error',
    param: 'previous_response_id',
    code: 'previous_response_not_found',
  },
});

const inputItemNotFound = (id: string) => ({
  error: { message: `Item with id '${id}' not found.`, type: 'invalid_request_error', param: 'input', code: null },
});

export const prepareResponsesTurn = async (
  original: CanonicalOpenAIResponsesPayload, store: OpenAIResponsesStatefulStore, env: StageEnv,
): Promise<{ readonly payload: CanonicalOpenAIResponsesPayload } | { readonly failure: ResponsesTurnBack }> => {
  const errorResponse = (status: number, body: unknown) => ({
    failure: {
      'response.http': jsonHttpResponse(status, body, env.clock()),
      'response.openaiResponses': undefined,
      ...emptyUsageFacts(env),
    },
  });
  let hydrated: CanonicalOpenAIResponsesPayload;
  try {
    const prepared = await expandPreviousResponseId(original, store);
    await store.loadInputItems(prepared.input, original.input);
    hydrated = hydrateOpenAIResponsesPayload(prepared, store);
  } catch (error) {
    if (error instanceof PreviousResponseNotFoundError) return errorResponse(400, previousNotFound(error.previousResponseId));
    const failure = tryCatchChatServeFailure<OpenAIResponsesServeFailure>(error);
    if (failure?.kind === 'item-not-found') return errorResponse(404, inputItemNotFound(failure.itemId));
    throw error;
  }
  await store.stageInputItems(original.input);
  return { payload: hydrated };
};

export const persistResponsesEvents = (
  source: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>,
  store: OpenAIResponsesStatefulStore,
  responseId: string,
  original: CanonicalOpenAIResponsesPayload,
  delivery: ResponsesDelivery,
) => wrapResponseResourceCompletion(
  wrapOpenAIResponsesClientOutput(source, { store, responseId }), {
    request: original, createdAt: delivery.createdAt, stored: store.writesState,
  },
);

export const statefulTurn = defineStage<Request, Request, ResponsesTurnBack, ResponsesTurnBack, Pick<GatewayServices, 'affinityCodec' | 'responsesStore'>>({
  name: 'statefulTurn',
  through: {
    request: { needs: ['request.openaiResponses', 'request.delivery'], consumes: [], provides: ['request.openaiResponses'] },
    response: { needs: ['response.http'], consumes: [], provides: ['response.http', 'response.openaiResponses'] },
  },
  return: { provides: ['response.http', 'response.openaiResponses', ...usageResponseKeys] },
  execute: async (facts, next, env) => {
    const original = facts['request.openaiResponses'];
    const delivery = facts['request.delivery'];
    const store = env.services.responsesStore({ kind: 'http', store: original.store ?? undefined });
    const prepared = await prepareResponsesTurn(original, store, env);
    if ('failure' in prepared) return prepared.failure;

    const response = await next({ ...facts, 'request.openaiResponses': prepared.payload });
    const http = response['response.http'];
    const received = response['response.openaiResponses'];
    const compact = response['response.result'];
    if (received === undefined && compact === undefined) return { ...response, 'response.openaiResponses': undefined };

    const responseId = createOpenAIResponsesResponseId();
    if (received === undefined) {
      if (compact === undefined || delivery.action !== 'compact') throw new Error('A generation returned an OpenAI Responses compact result');
      const candidate = response['response.route.candidate'];
      if (candidate === undefined) throw new Error('OpenAI Responses compact result has no selected candidate');
      const affinity = affinityIdentityForCandidate(candidate);
      return {
        ...response,
        'response.openaiResponses': env.createStream({
          label: 'stored OpenAI Responses compact result',
          iterate: () => wrapOpenAIResponsesClientOutput(wrapOpenAIResponsesAffinityEgress(syntheticEventsFromCompaction(compact), {
            codec: env.services.affinityCodec, affinity,
          }), { store, responseId }),
        }),
      };
    }

    return {
      ...response,
      'response.http': delivery.action === 'compact' ? http : {
        ...http,
        headers: [...http.headers.filter(([name]) => name.toLowerCase() !== OPENAI_RESPONSES_REASONING_INCLUDED_HEADER),
          [OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE]],
      },
      'response.openaiResponses': env.wrapStream(received, {
        label: 'stored OpenAI Responses events',
        transform: source => delivery.action === 'compact'
          ? wrapOpenAIResponsesClientOutput(source, { store, responseId })
          : persistResponsesEvents(source, store, responseId, original, delivery),
      }),
    };
  },
});
