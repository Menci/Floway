import type { ResponsesBodyBack } from './facts.ts';
import { jsonHttpResponse } from '../../../pipeline/edge-http.ts';
import type { SelectedAttemptResponse } from '../../../pipeline/failover.ts';
import { emptyUsageFacts, usageResponseKeys } from '../../../pipeline/observe-usage.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import { affinityIdentityForCandidate } from '../../shared/affinity/selection.ts';
import type { DeliveryFacts } from '../../shared/encode.ts';
import { wrapOpenAIResponsesAffinityEgress } from '../affinity/egress.ts';
import type { ResponsesDelivery } from '../encode.ts';
import { responsesInputErrorBody } from '../errors.ts';
import { hydrateOpenAIResponsesPayload, ResponsesItemNotFoundError } from '../items/hydrate.ts';
import { syntheticEventsFromCompaction, wrapOpenAIResponsesClientOutput } from '../items/output.ts';
import { expandPreviousResponseId, PreviousResponseNotFoundError } from '../items/previous-response.ts';
import type { OpenAIResponsesStatefulStore } from '../items/store.ts';
import { OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE } from '../response-headers.ts';
import { createOpenAIResponsesResponseId } from '../response-id.ts';
import { wrapResponseResourceCompletion } from '../response-resource.ts';
import type { WebSocketInterrupt, WebSocketInterruptAccepted } from '../websocket-wire.ts';
import { defineStage, type ManagedStream, type StageEnv } from '@floway-dev/pipeline';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIResponsesPayload, OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';

type Request = DeliveryFacts<ResponsesDelivery> & {
  readonly 'request.openaiResponses': CanonicalOpenAIResponsesPayload;
  readonly 'request.ws.controls'?: ManagedStream<WebSocketInterrupt>;
  readonly 'request.ws.responseId'?: string;
};
type ControlFrame = { readonly type: 'control' };
export type ResponsesTurnBack<Control extends ControlFrame = never> = Omit<ResponsesBodyBack, 'response.openaiResponses'> &
  Partial<Pick<SelectedAttemptResponse, 'response.route.candidate'>> & {
    readonly 'response.openaiResponses'?: ManagedStream<ProtocolFrame<OpenAIResponsesStreamEventEx> | Control>;
  };

const previousNotFound = (id: string) => ({
  error: {
    message: `Previous response with id '${id}' not found.`,
    type: 'invalid_request_error',
    param: 'previous_response_id',
    code: 'previous_response_not_found',
  },
});

const prepareResponsesTurn = async (
  original: CanonicalOpenAIResponsesPayload, store: OpenAIResponsesStatefulStore, env: StageEnv,
): Promise<{ readonly payload: CanonicalOpenAIResponsesPayload } | { readonly failure: ResponsesTurnBack }> => {
  const errorResponse = (status: number, body: unknown) => ({
    failure: {
      'response.http': jsonHttpResponse(status, body, env.clock()),
      'response.openaiResponses': undefined,
      'response.source': 'gateway' as const,
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
    if (error instanceof ResponsesItemNotFoundError) return errorResponse(404, responsesInputErrorBody(error));
    throw error;
  }
  await store.stageInputItems(original.input);
  return { payload: hydrated };
};

const persistResponsesEvents = <Control extends ControlFrame>(
  source: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx> | Control>,
  store: OpenAIResponsesStatefulStore,
  responseId: string,
  original: CanonicalOpenAIResponsesPayload,
  delivery: ResponsesDelivery,
) => wrapResponseResourceCompletion<Control>(
  wrapOpenAIResponsesClientOutput<Control>(source, { store, responseId }), {
    request: original, createdAt: delivery.createdAt, stored: store.writesState,
  },
);

type StoreServices = Pick<GatewayServices, 'responsesStore'>;
type ProjectTurn<S, Control extends ControlFrame> = (
  response: ResponsesTurnBack<Control>, request: Request, store: OpenAIResponsesStatefulStore, env: StageEnv<S>,
) => ResponsesTurnBack<Control>;

const createStatefulTurn = <S extends StoreServices, Control extends ControlFrame = never>(
  project: ProjectTurn<S, Control>,
) => defineStage<Request, Request, ResponsesTurnBack<Control>, ResponsesTurnBack<Control>, S>({
  name: 'statefulTurn',
  through: {
    request: { needs: ['request.openaiResponses', 'request.delivery'], consumes: [], provides: ['request.openaiResponses'] },
    response: { needs: ['response.http'], consumes: [], provides: ['response.http', 'response.openaiResponses'] },
  },
  return: { provides: ['response.http', 'response.openaiResponses', 'response.source', ...usageResponseKeys] },
  execute: async (facts, next, env) => {
    const original = facts['request.openaiResponses'];
    const store = env.services.responsesStore({ kind: 'http', store: original.store ?? undefined });
    const closeControls = async () => {
      if (!env.signal.aborted) await facts['request.ws.controls']?.close();
    };
    const prepared = await prepareResponsesTurn(original, store, env).catch(async (error: unknown) => {
      await closeControls();
      throw error;
    });
    if ('failure' in prepared) {
      await closeControls();
      return prepared.failure;
    }

    const response = await next({ ...facts, 'request.openaiResponses': prepared.payload });
    return project(response, facts, store, env);
  },
});

export const statefulTurn = createStatefulTurn<StoreServices, WebSocketInterruptAccepted>((response, request, store, env) => {
  const events = response['response.openaiResponses'];
  if (events === undefined) {
    if (response['response.result'] !== undefined) throw new Error('A generation returned an OpenAI Responses compact result');
    return { ...response, 'response.openaiResponses': undefined };
  }
  const http = response['response.http'];
  const responseId = request['request.ws.responseId'] ?? createOpenAIResponsesResponseId();
  return {
    ...response,
    'response.http': request['request.delivery'].transport === 'websocket' ? http : {
      ...http,
      headers: [...http.headers.filter(([name]) => name.toLowerCase() !== OPENAI_RESPONSES_REASONING_INCLUDED_HEADER),
        [OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE]],
    },
    'response.openaiResponses': env.wrapStream(events, {
      label: 'stored OpenAI Responses events',
      transform: source => persistResponsesEvents(source, store, responseId, request['request.openaiResponses'], request['request.delivery']),
    }),
  };
});

export const compactStatefulTurn = createStatefulTurn<Pick<GatewayServices, 'affinityCodec' | 'responsesStore'>>((response, _request, store, env) => {
  const events = response['response.openaiResponses'];
  if (events !== undefined) {
    const responseId = createOpenAIResponsesResponseId();
    return {
      ...response,
      'response.openaiResponses': env.wrapStream(events, {
        label: 'stored OpenAI Responses compact events',
        transform: source => wrapOpenAIResponsesClientOutput<never>(source, { store, responseId }),
      }),
    };
  }

  const compact = response['response.result'];
  if (compact === undefined) return { ...response, 'response.openaiResponses': undefined };
  const candidate = response['response.route.candidate'];
  if (candidate === undefined) throw new Error('OpenAI Responses compact result has no selected candidate');
  const options = { codec: env.services.affinityCodec, affinity: affinityIdentityForCandidate(candidate) };
  const responseId = createOpenAIResponsesResponseId();
  return {
    ...response,
    'response.openaiResponses': env.createStream({
      label: 'stored OpenAI Responses compact result',
      iterate: () => wrapOpenAIResponsesClientOutput<never>(wrapOpenAIResponsesAffinityEgress(syntheticEventsFromCompaction(compact), options), { store, responseId }),
    }),
  };
});
