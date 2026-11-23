import { wrapOpenAIResponsesAffinityEgress } from './affinity/egress.ts';
import { analyzeOpenAIResponsesAffinity, evaluateOpenAIResponsesCandidate, type OpenAIResponsesRequestAnalysis, scoreOpenAIResponsesCandidate } from './affinity/ingress.ts';
import { encodeResponses, encodeResponsesCompact, openAIResponsesInternalErrorBody, type ResponsesDelivery } from './encode.ts';
import { responsesInputErrorBody } from './errors.ts';
import { compactStatefulTurn, statefulTurn } from './stages/stateful-turn.ts';
import { answerKeys, gatewayAnswer } from '../../pipeline/answer.ts';
import { edgeHttp, type HttpOutput, jsonHttpResponse } from '../../pipeline/edge-http.ts';
import { type CandidateRequest, failover } from '../../pipeline/failover.ts';
import type { GatewayHttpFacts } from '../../pipeline/host.ts';
import { requestBytes } from '../../pipeline/non-chat.ts';
import type { UsageFacts } from '../../pipeline/observe-usage.ts';
import type { RenderFacts } from '../../pipeline/render.ts';
import { createResolveCandidates, type ModelRequest } from '../../pipeline/resolve-candidates.ts';
import type { GatewayServices, RouteCandidate } from '../../pipeline/services.ts';
import { priceUsage, type SettlementFacts, writeSettlement } from '../../pipeline/settlement.ts';
import { type AffinityFacts, createAffinity, createAnalyzeAffinity, isAffinityRoutingFailure, selectChatCandidates } from '../shared/affinity/stages.ts';
import type { DeliveryFacts } from '../shared/encode.ts';
import { type ChatBodyInput, type ChatBodyOutput, enterChatBody } from '../shared/route-body.ts';
import { serializeOpenAIResponsesStream } from '../shared/stream-compatibility/index.ts';
import { openaiResponsesTarget } from '../shared/target-picker.ts';
import { compose, defineStage, type Pipeline, type Stage, type StaticTarget } from '@floway-dev/pipeline';
import { type CanonicalOpenAIResponsesPayload, canonicalizeOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { OpenAIResponsesAction } from '@floway-dev/provider';

type Body = 'openaiResponses';
type ChatBody = Pipeline<ChatBodyInput<Body>, ChatBodyOutput<Body>, GatewayServices>;
type Targets = { body: StaticTarget<ChatBodyInput<Body>, ChatBodyOutput<Body>, GatewayServices> };

export interface ResponsesRequest extends GatewayHttpFacts, ModelRequest, DeliveryFacts<ResponsesDelivery> {
  readonly 'request.openaiResponses': CanonicalOpenAIResponsesPayload;
  readonly 'request.action': OpenAIResponsesAction;
}

type ParsedResponse = HttpOutput & UsageFacts & Partial<RenderFacts>;

type HttpRequest = GatewayHttpFacts & { readonly 'request.startedAt': number };

const parsePayload = (action: OpenAIResponsesAction) => defineStage<HttpRequest, ResponsesRequest, ParsedResponse, ParsedResponse>({
  name: 'parsePayload',
  through: {
    request: { needs: ['request.http', 'request.startedAt'], consumes: [], provides: ['request.model', 'request.openaiResponses', 'request.action', 'request.delivery'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: answerKeys },
  execute: async (facts, next, env) => {
    const bytes = requestBytes(facts['request.http']);
    let body: unknown;
    try {
      body = JSON.parse(bytes.utf8());
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return gatewayAnswer(env, jsonHttpResponse(502, openAIResponsesInternalErrorBody(error), env.clock()));
    }
    const parsed = canonicalizeOpenAIResponsesPayload(body);
    if ('error' in parsed) return gatewayAnswer(env, jsonHttpResponse(400, responsesInputErrorBody(parsed.error), env.clock()));
    return await next({
      ...facts,
      'request.model': parsed.model,
      'request.openaiResponses': parsed,
      'request.action': action,
      'request.delivery': {
        stream: action === 'generate' && parsed.stream === true,
        createdAt: Math.floor(facts['request.startedAt'] / 1000),
        transport: 'http',
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
export const resolveResponsesCandidates = createResolveCandidates<RouteCandidate, CandidateInput>({
  kind: 'chat',
  sourceApi: '/responses',
  requestNeeds: ['request.openaiResponses', 'request.affinity'],
  select(candidates, facts) {
    return selectChatCandidates(candidates, openaiResponsesTarget, facts['request.affinity'], facts['request.openaiResponses'],
      scoreOpenAIResponsesCandidate, facts['request.model']);
  },
  errorBody: error => ({
    error: {
      message: error.message,
      type: 'invalid_request_error',
      ...(isAffinityRoutingFailure(error) ? { param: 'input', code: 'responses_item_routing_unavailable' } : {}),
    },
  }),
});

export const serializeItems = defineStage<
  CandidateRequest,
  CandidateRequest,
  ChatBodyOutput<Body>,
  ChatBodyOutput<Body>
>({
  name: 'serializeItems',
  through: {
    request: { needs: ['route.candidate'], consumes: [], provides: [] },
    response: { needs: ['response.openaiResponses'], consumes: [], provides: ['response.openaiResponses'] },
  },
  execute: async (facts, next, env) => {
    const response = await next(facts);
    const events = response['response.openaiResponses'];
    if (events === undefined || !facts['route.candidate'].providerModel.enabledFlags.includes('serialize-stream-items')) return response;
    return {
      ...response,
      'response.openaiResponses': env.wrapStream(events, {
        label: 'serialized OpenAI Responses items',
        transform: source => serializeOpenAIResponsesStream(source, true),
      }),
    };
  },
});

const createIngress = (
  body: ChatBody, action: OpenAIResponsesAction,
  encode: Stage<GatewayServices>, persist: Stage<GatewayServices>, afterAffinity: readonly Stage<GatewayServices>[],
) =>
  compose<GatewayHttpFacts, HttpOutput & SettlementFacts, GatewayServices, Targets>(`openai-responses.${action}.ingress`, {
    stages: [
      writeSettlement('chat'), priceUsage, edgeHttp, parsePayload(action), encode,
      persist, analyzeResponsesAffinity, resolveResponsesCandidates, failover, responsesAffinity, ...afterAffinity,
    ],
    targets: { body },
    ending: enterChatBody('openaiResponses'),
  });

export const createOpenAIResponsesIngress = (body: ChatBody) =>
  createIngress(body, 'generate', encodeResponses, statefulTurn, [serializeItems]);
export const createOpenAIResponsesCompactIngress = (body: ChatBody) =>
  createIngress(body, 'compact', encodeResponsesCompact, compactStatefulTurn, []);
