import { decodeOpenAIChatCompletionsAffinity, evaluateOpenAIChatCompletionsAffinity, type OpenAIChatCompletionsAffinityAnalysis, scoreOpenAIChatCompletionsAffinity } from './affinity/analysis.ts';
import { wrapOpenAIChatCompletionsAffinityEgress } from './affinity/egress.ts';
import { openaiChatCompletionsInputError } from './errors.ts';
import { edgeHttp, type HttpDeliveryFacts, type HttpOutput, jsonHttpResponse, stripFlowayAuth } from '../../pipeline/edge-http.ts';
import { createFailover } from '../../pipeline/failover.ts';
import { GATEWAY_HTTP_ENTRY, type GatewayHttpFacts, isUploadError } from '../../pipeline/host.ts';
import { parseJsonModel } from '../../pipeline/non-chat.ts';
import { localHttpAnswer, type RenderFacts } from '../../pipeline/render.ts';
import { createResolveCandidates, type ModelRequest } from '../../pipeline/resolve-candidates.ts';
import type { GatewayServices, RouteCandidate } from '../../pipeline/services.ts';
import { openaiInternalErrorPayload } from '../../shared/openai-error-payload.ts';
import { serializeSseFrame } from '../../shared/sse.ts';
import { type AffinityFacts, createAffinity, createAnalyzeAffinity, isAffinityRoutingFailure, selectChatCandidates } from '../shared/affinity/stages.ts';
import { createEncode, type DeliveryFacts, type DeliveryIntent, transportErrorForDisplay } from '../shared/encode.ts';
import { type ChatBodyInput, type ChatBodyOutput, type ChatPayloadFacts, enterChatBody } from '../shared/route-body.ts';
import { openaiChatCompletionsTarget } from '../shared/target-picker.ts';
import { compose, defineStage, type Pipeline } from '@floway-dev/pipeline';
import { sseFrame } from '@floway-dev/protocols/common';
import { collectOpenAIChatCompletionsProtocolEventsToResult, type OpenAIChatCompletionsPayloadEx, openaiChatCompletionsErrorPayloadMessage, openaiChatCompletionsProtocolFrameToSSEFrame } from '@floway-dev/protocols/openai-chat-completions';
import { toInternalDebugError } from '@floway-dev/provider';

type Api = 'openaiChatCompletions';
const api: Api = 'openaiChatCompletions';
interface ChatCompletionsDelivery extends DeliveryIntent {
  readonly includeUsageChunk: boolean;
  readonly expectedChoices: number;
}
type Parsed = GatewayHttpFacts & ModelRequest & ChatPayloadFacts<Api> & DeliveryFacts<ChatCompletionsDelivery>;
type Rendered = HttpOutput & RenderFacts;

const parsePayload = defineStage<GatewayHttpFacts, Parsed, Rendered, Rendered>({
  name: 'parsePayload',
  through: {
    request: {
      needs: ['request.http'], consumes: [],
      provides: ['request.model', 'request.openaiChatCompletions', 'request.delivery'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: ['response.http', 'response.render'] },
  execute: async (facts, scope) => {
    const http = facts['request.http'];
    if (isUploadError(http.body)) {
      const error = transportErrorForDisplay(http.body.error);
      return localHttpAnswer(scope, jsonHttpResponse(502, openaiChatCompletionsHttpOptions.errorBody(error), scope.clock()));
    }
    const parsed = parseJsonModel(http, 'Chat Completions');
    if ('error' in parsed) {
      const body = { error: { message: parsed.error, type: 'invalid_request_error', param: null, code: null } };
      return localHttpAnswer(scope, jsonHttpResponse(400, body, scope.clock()));
    }
    const payload = { ...parsed.payload, model: parsed.model } as OpenAIChatCompletionsPayloadEx;
    const nullableField = payload.prompt_cache_options === null ? 'prompt_cache_options' : payload.user === null ? 'user' : undefined;
    if (nullableField !== undefined) {
      const body = openaiChatCompletionsInputError({
        message: `Invalid '${nullableField}': expected ${nullableField === 'user' ? 'a string' : 'an object'} when present.`,
        param: nullableField,
      });
      return localHttpAnswer(scope, jsonHttpResponse(400, body, scope.clock()));
    }
    if (!Array.isArray(payload.messages)) {
      const body = openaiChatCompletionsInputError({ message: "Invalid 'messages': expected an array." });
      return localHttpAnswer(scope, jsonHttpResponse(400, body, scope.clock()));
    }
    return await scope.next({
      ...facts,
      'request.model': payload.model,
      'request.openaiChatCompletions': payload,
      'request.delivery': {
        stream: payload.stream === true,
        includeUsageChunk: payload.stream_options?.include_usage === true,
        expectedChoices: payload.n ?? 1,
      },
    });
  },
});

const analyzeAffinity = createAnalyzeAffinity(api, decodeOpenAIChatCompletionsAffinity);
const affinity = createAffinity(api, {
  evaluate: evaluateOpenAIChatCompletionsAffinity,
  wrap: wrapOpenAIChatCompletionsAffinityEgress,
});
const resolveCandidates = createResolveCandidates<RouteCandidate, Parsed & AffinityFacts<OpenAIChatCompletionsAffinityAnalysis>>({
  kind: 'chat',
  sourceApi: '/chat/completions',
  requestNeeds: ['request.affinity', 'request.openaiChatCompletions'],
  select: (candidates, facts) => selectChatCandidates(
    candidates, openaiChatCompletionsTarget, facts['request.affinity'], facts['request.openaiChatCompletions'],
    scoreOpenAIChatCompletionsAffinity, facts['request.model'],
  ),
  errorBody: error => ({
    error: {
      message: error.message,
      type: 'invalid_request_error',
      ...(isAffinityRoutingFailure(error) ? { param: 'input', code: 'responses_item_routing_unavailable' } : {}),
    },
  }),
});

const encode = createEncode<Api, ChatCompletionsDelivery>(api, {
  encodeJson: collectOpenAIChatCompletionsProtocolEventsToResult,
  transportError: error => ({ status: 502, body: openaiChatCompletionsHttpOptions.errorBody(error) }),
  openSse: ({ includeUsageChunk, expectedChoices }) => {
    const finishedChoices = new Set<number>();
    return {
      encode: frame => {
        const output = openaiChatCompletionsProtocolFrameToSSEFrame(frame, { includeUsageChunk });
        const wire = output === null ? null : serializeSseFrame(output);
        if (frame.type === 'done') return { wire, end: { type: 'completed' } };
        if (openaiChatCompletionsErrorPayloadMessage(frame.event) !== null) return { wire, end: { type: 'protocol-error' } };
        for (const { index, finish_reason: reason } of frame.event.choices) {
          if (reason != null && Number.isInteger(index) && index >= 0 && index < expectedChoices) finishedChoices.add(index);
        }
        return { wire };
      },
      eof: () => finishedChoices.size === expectedChoices
        ? { type: 'completed' }
        : { type: 'premature-eof', error: new Error('OpenAI Chat Completions stream ended before all choices finished.') },
      // The SDK recognizes a top-level error on an unnamed SSE data frame.
      // https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/core/streaming.ts#L56-L73
      failure: error => [serializeSseFrame(sseFrame(JSON.stringify(openaiInternalErrorPayload(toInternalDebugError(error)))))],
    };
  },
});

const failover = createFailover('response.openaiChatCompletions');
type Space = GatewayHttpFacts & Rendered & HttpDeliveryFacts;

export const createOpenAIChatCompletionsIngress = (body: Pipeline<ChatBodyInput<Api>, ChatBodyOutput<Api>, GatewayServices>) =>
  compose<Space, GatewayServices>()('openaiChatCompletions.ingress', {
    entry: GATEWAY_HTTP_ENTRY,
    exit: ['response.http', 'response.render', 'response.delivery'],
    stages: [edgeHttp, stripFlowayAuth, parsePayload, analyzeAffinity, resolveCandidates, encode, failover, affinity],
    ending: enterChatBody(api),
    targets: { body },
  });

export const openaiChatCompletionsHttpOptions = {
  errorStatus: (): 502 => 502,
  errorBody: (error: unknown) => openaiInternalErrorPayload(toInternalDebugError(error)),
} as const;
