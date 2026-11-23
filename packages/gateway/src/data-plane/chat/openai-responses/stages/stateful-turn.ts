import type { ResponsesBodyBack } from './facts.ts';
import type { GatewayServices } from '../../../pipeline/services.ts';
import type { DeliveryFacts } from '../../shared/encode.ts';
import { openAIResponsesInternalErrorBody, type ResponsesDelivery } from '../encode.ts';
import { localResponsesError, responsesInputErrorBody } from '../errors.ts';
import { hydrateOpenAIResponsesPayload, ResponsesItemNotFoundError } from '../items/hydrate.ts';
import { syntheticEventsFromCompaction, wrapOpenAIResponsesClientOutput } from '../items/output.ts';
import { expandPreviousResponseId } from '../items/previous-response.ts';
import type { OpenAIResponsesStatefulStore } from '../items/store.ts';
import { OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE } from '../response-headers.ts';
import { createOpenAIResponsesResponseId } from '../response-id.ts';
import { wrapResponseResourceCompletion } from '../response-resource.ts';
import type { WebSocketInterrupt, WebSocketInterruptAccepted } from '../websocket-wire.ts';
import type { TransportFailure } from '@floway-dev/http';
import { defineStage, type FactValue, type ManagedStream, type Scope } from '@floway-dev/pipeline';
import {
  type CanonicalOpenAIResponsesPayload, collectOpenAIResponsesProtocolEventsToResult,
  type OpenAIResponsesStreamEventEx,
} from '@floway-dev/protocols/openai-responses';
import type { OpenAIResponsesAction, ProviderFrame } from '@floway-dev/provider';

type Request = DeliveryFacts<ResponsesDelivery> & {
  readonly 'request.action': OpenAIResponsesAction;
  readonly 'request.openaiResponses': CanonicalOpenAIResponsesPayload;
  readonly 'request.ws.controls'?: ManagedStream<WebSocketInterrupt>;
  readonly 'request.ws.responseId'?: string;
};
type ExtraFrame = TransportFailure | WebSocketInterruptAccepted;
type ResponseOutcome = ResponsesBodyBack['response.openaiResponses'];
export type ResponsesTurnBack<Control = never> = Omit<ResponsesBodyBack, 'response.openaiResponses'> & {
  readonly 'response.openaiResponses': Exclude<ResponseOutcome, { kind: 'stream' }> | {
    readonly kind: 'stream';
    readonly events: ManagedStream<ProviderFrame<OpenAIResponsesStreamEventEx> | Control>;
  };
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
  original: CanonicalOpenAIResponsesPayload, store: OpenAIResponsesStatefulStore, scope: Pick<Scope, 'clock'>,
): Promise<{ readonly payload: CanonicalOpenAIResponsesPayload } | { readonly failure: ResponsesTurnBack }> => {
  const prepared = await expandPreviousResponseId(original, store);
  if ('previousResponseNotFound' in prepared) return { failure: localResponsesError(scope, 400, previousNotFound(prepared.previousResponseNotFound)) };
  await store.loadInputItems(prepared.input, original.input);
  let hydrated: CanonicalOpenAIResponsesPayload;
  try {
    hydrated = hydrateOpenAIResponsesPayload(prepared, store);
  } catch (error) {
    if (error instanceof ResponsesItemNotFoundError) return { failure: localResponsesError(scope, 404, responsesInputErrorBody(error)) };
    throw error;
  }
  await store.stageInputItems(original.input);
  return { payload: hydrated };
};

type StoreServices = Pick<GatewayServices, 'responsesStore'>;

export const statefulTurn = defineStage<Request, Request, ResponsesTurnBack<WebSocketInterruptAccepted>, ResponsesTurnBack<WebSocketInterruptAccepted>, StoreServices>({
  name: 'statefulTurn',
  through: {
    request: { needs: ['request.action', 'request.openaiResponses', 'request.delivery'], consumes: [], provides: ['request.openaiResponses'] },
    response: { needs: ['response.http', 'response.openaiResponses'], consumes: [], provides: ['response.http', 'response.openaiResponses'] },
  },
  return: { provides: ['response.http', 'response.openaiResponses'] },
  execute: async (facts, scope) => {
    const original = facts['request.openaiResponses'];
    const store = scope.services.responsesStore({ kind: 'http', store: original.store ?? undefined });
    const websocket = 'request.ws.responseId' in facts;
    const prepared = await prepareResponsesTurn(original, store, scope);
    if ('failure' in prepared) {
      await facts['request.ws.controls']?.close();
      return prepared.failure;
    }

    const response = await scope.next({ ...facts, 'request.openaiResponses': prepared.payload });
    const outcome = response['response.openaiResponses'];
    if (outcome.kind === 'error') return response;
    const responseId = facts['request.ws.responseId'] ?? createOpenAIResponsesResponseId();
    if (outcome.kind === 'result') {
      if (outcome.result.usage == null) {
        const error = openAIResponsesInternalErrorBody(new TypeError('OpenAI Responses compaction upstream reported no token usage; the compaction resource requires it'));
        const http = response['response.http'];
        return {
          ...response,
          'response.http': { ...http, status: 502, statusText: '', body: null },
          'response.openaiResponses': { kind: 'error', source: 'upstream', error: error as FactValue },
        };
      }
      const result = await collectOpenAIResponsesProtocolEventsToResult(wrapOpenAIResponsesClientOutput<never>(
        syntheticEventsFromCompaction(outcome.result), { store, responseId },
      ));
      return { ...response, 'response.openaiResponses': { kind: 'result', result: { ...outcome.result, id: result.id, output: result.output } } };
    }
    const compact = facts['request.action'] === 'compact';
    const http = response['response.http'];
    return {
      ...response,
      'response.http': websocket || compact ? http : {
        ...http,
        headers: [...http.headers.filter(([name]) => name.toLowerCase() !== OPENAI_RESPONSES_REASONING_INCLUDED_HEADER),
          [OPENAI_RESPONSES_REASONING_INCLUDED_HEADER, OPENAI_RESPONSES_REASONING_INCLUDED_VALUE]],
      },
      'response.openaiResponses': {
        kind: 'stream',
        events: scope.wrapStream(outcome.events, {
          label: 'stored OpenAI Responses events',
          transform(source) {
            const persisted = wrapOpenAIResponsesClientOutput<ExtraFrame>(source, { store, responseId });
            return compact ? persisted : wrapResponseResourceCompletion<ExtraFrame>(persisted, {
              request: original, createdAt: facts['request.delivery'].createdAt, stored: store.writesState,
            });
          },
        }),
      },
    };
  },
});
