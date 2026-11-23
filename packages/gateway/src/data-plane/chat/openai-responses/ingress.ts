import { wrapOpenAIResponsesAffinityEgress } from './affinity/egress.ts';
import { analyzeOpenAIResponsesAffinity, evaluateOpenAIResponsesCandidate, type OpenAIResponsesRequestAnalysis, scoreOpenAIResponsesCandidate } from './affinity/ingress.ts';
import { encodeResponses, encodeResponsesCompact, openAIResponsesInternalErrorBody, type ResponsesDelivery } from './encode.ts';
import { localResponsesError, responsesInputErrorBody } from './errors.ts';
import { syntheticEventsFromCompaction } from './items/output.ts';
import { statefulTurn } from './stages/stateful-turn.ts';
import { edgeHttp, type HttpDeliveryFacts, type HttpOutput, jsonHttpResponse, stripFlowayAuth } from '../../pipeline/edge-http.ts';
import { type CandidateRequest, type CandidatesRequest, createFailover } from '../../pipeline/failover.ts';
import { GATEWAY_HTTP_ENTRY, type GatewayHttpFacts, isUploadError } from '../../pipeline/host.ts';
import { requestBytes } from '../../pipeline/non-chat.ts';
import { localHttpAnswer, type RenderFacts } from '../../pipeline/render.ts';
import type { ModelRequest } from '../../pipeline/resolve-candidates.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import { appendFailedUpstreams } from '../../shared/failed-upstreams.ts';
import { affinityIdentityForCandidate } from '../shared/affinity/selection.ts';
import { type AffinityFacts, createAffinity, createAnalyzeAffinity, isAffinityRoutingFailure, selectChatCandidates } from '../shared/affinity/stages.ts';
import { type DeliveryFacts, transportErrorForDisplay } from '../shared/encode.ts';
import { type ChatBodyInput, type ChatBodyOutput, enterChatBody } from '../shared/route-body.ts';
import { serializeOpenAIResponsesStream } from '../shared/stream-compatibility/index.ts';
import { wrapProtocolFrames } from '../shared/stream-frames.ts';
import { openaiResponsesTarget } from '../shared/target-picker.ts';
import { compose, defineStage, type Pipeline } from '@floway-dev/pipeline';
import { type CanonicalOpenAIResponsesPayload, canonicalizeOpenAIResponsesPayload, collectOpenAIResponsesProtocolEventsToResult } from '@floway-dev/protocols/openai-responses';
import type { OpenAIResponsesAction } from '@floway-dev/provider';

type Body = 'openaiResponses';
type ChatBody = Pipeline<ChatBodyInput<Body>, ChatBodyOutput<Body>, GatewayServices>;

export interface ResponsesRequest extends GatewayHttpFacts, ModelRequest, DeliveryFacts<ResponsesDelivery> {
  readonly 'request.openaiResponses': CanonicalOpenAIResponsesPayload;
  readonly 'request.action': OpenAIResponsesAction;
}

type ParsedResponse = HttpOutput & RenderFacts;
type IngressFacts = GatewayHttpFacts & ParsedResponse & HttpDeliveryFacts;
const exit = ['response.http', 'response.render', 'response.delivery'] as const;

const parsePayload = (action: OpenAIResponsesAction) => defineStage<GatewayHttpFacts, ResponsesRequest, ParsedResponse, ParsedResponse>({
  name: 'parsePayload',
  through: {
    request: { needs: ['request.http', 'request.startedAt'], consumes: [], provides: ['request.model', 'request.openaiResponses', 'request.action', 'request.delivery'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: ['response.http', 'response.render'] },
  execute: async (facts, scope) => {
    const http = facts['request.http'];
    if (isUploadError(http.body)) {
      return localHttpAnswer(scope, jsonHttpResponse(502, openAIResponsesInternalErrorBody(transportErrorForDisplay(http.body.error)), scope.clock()));
    }
    const bytes = requestBytes(http);
    let body: unknown;
    try {
      body = JSON.parse(bytes.utf8());
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return localHttpAnswer(scope, jsonHttpResponse(502, openAIResponsesInternalErrorBody(error), scope.clock()));
    }
    const parsed = canonicalizeOpenAIResponsesPayload(body);
    if ('error' in parsed) return localHttpAnswer(scope, jsonHttpResponse(400, responsesInputErrorBody(parsed.error), scope.clock()));
    return await scope.next({
      ...facts,
      'request.model': parsed.model,
      'request.openaiResponses': parsed,
      'request.action': action,
      'request.delivery': {
        stream: action === 'generate' && parsed.stream === true,
        createdAt: Math.floor(facts['request.startedAt'] / 1000),
      },
    });
  },
});

export const analyzeResponsesAffinity = createAnalyzeAffinity('openaiResponses', analyzeOpenAIResponsesAffinity);
export const responsesAffinity = createAffinity('openaiResponses', {
  evaluate: evaluateOpenAIResponsesCandidate,
  wrap: wrapOpenAIResponsesAffinityEgress,
});

type CandidateInput = ResponsesRequest & AffinityFacts<OpenAIResponsesRequestAnalysis>;
type CandidateServices = Pick<GatewayServices, 'providers' | 'modelsRefresh'>;
type BodyBack = ChatBodyOutput<Body>;

export const resolveResponsesCandidates = defineStage<CandidateInput, CandidateInput & CandidatesRequest, BodyBack, BodyBack, CandidateServices>({
  name: 'resolveCandidates',
  through: {
    request: {
      needs: ['request.model', 'request.auth.user', 'request.route.upstreamIds', 'request.route.randomizeUpstreams',
        'request.openaiResponses', 'request.affinity'],
      consumes: [],
      provides: ['route.candidates'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: ['response.http', 'response.openaiResponses'] },
  execute: async (facts, scope) => {
    const model = facts['request.model'];
    const { candidates, sawModel, failedUpstreams, staleRefreshes } = await scope.services.providers.enumerate(facts, model, 'chat');
    for (const target of staleRefreshes) scope.defer('models.refresh', scope.services.modelsRefresh(target));
    const selection = selectChatCandidates(candidates, openaiResponsesTarget, facts['request.affinity'], facts['request.openaiResponses'],
      scoreOpenAIResponsesCandidate, model);
    if (!('status' in selection) && selection.length > 0) {
      return await scope.next({ ...facts, 'route.candidates': selection });
    }
    const unavailable = 'status' in selection && isAffinityRoutingFailure(selection);
    const message = 'status' in selection ? selection.message : appendFailedUpstreams(sawModel
      ? `Model ${model} does not support the /responses endpoint.`
      : `Model ${model} is not available on any configured upstream.`, failedUpstreams);
    return localResponsesError(scope, unavailable || sawModel ? 400 : 404, {
      error: { message, type: 'invalid_request_error', ...(unavailable ? { param: 'input', code: 'responses_item_routing_unavailable' } : {}) },
    });
  },
});

export const failoverResponses = createFailover('response.openaiResponses');

export const serializeItems = defineStage<
  CandidateRequest,
  CandidateRequest,
  ChatBodyOutput<Body>,
  ChatBodyOutput<Body>,
  Pick<GatewayServices, 'affinityCodec'>
>({
  name: 'serializeItems',
  through: {
    request: { needs: ['route.candidate'], consumes: [], provides: [] },
    response: { needs: ['response.openaiResponses'], consumes: [], provides: ['response.openaiResponses'] },
  },
  execute: async (facts, scope) => {
    const response = await scope.next(facts);
    const outcome = response['response.openaiResponses'];
    const candidate = facts['route.candidate'];
    if (outcome.kind === 'result') {
      const options = { codec: scope.services.affinityCodec, affinity: affinityIdentityForCandidate(candidate) };
      const { output } = await collectOpenAIResponsesProtocolEventsToResult(
        wrapOpenAIResponsesAffinityEgress(syntheticEventsFromCompaction(outcome.result), options),
      );
      return { ...response, 'response.openaiResponses': { kind: 'result', result: { ...outcome.result, output } } };
    }
    if (outcome.kind !== 'stream' || !candidate.providerModel.enabledFlags.includes('serialize-stream-items')) return response;
    return {
      ...response,
      'response.openaiResponses': {
        kind: 'stream', events: wrapProtocolFrames(outcome.events, scope, 'serialized OpenAI Responses items',
          source => serializeOpenAIResponsesStream(source, true)),
      },
    };
  },
});

const createIngress = (body: ChatBody, action: OpenAIResponsesAction) =>
  compose<IngressFacts, GatewayServices>()(`openai-responses.${action}.ingress`, {
    entry: GATEWAY_HTTP_ENTRY,
    exit,
    stages: [
      edgeHttp, stripFlowayAuth, parsePayload(action), action === 'compact' ? encodeResponsesCompact : encodeResponses,
      statefulTurn, analyzeResponsesAffinity, resolveResponsesCandidates, failoverResponses, responsesAffinity, serializeItems,
    ],
    targets: { body },
    ending: enterChatBody('openaiResponses'),
  });

export const createOpenAIResponsesIngress = (body: ChatBody) => createIngress(body, 'generate');
export const createOpenAIResponsesCompactIngress = (body: ChatBody) => createIngress(body, 'compact');
