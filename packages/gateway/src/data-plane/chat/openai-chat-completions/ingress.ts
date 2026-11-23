import { decodeOpenAIChatCompletionsAffinity, evaluateOpenAIChatCompletionsAffinity, type OpenAIChatCompletionsAffinityAnalysis, scoreOpenAIChatCompletionsAffinity } from './affinity/analysis.ts';
import { wrapOpenAIChatCompletionsAffinityEgress } from './affinity/egress.ts';
import { answerKeys, gatewayAnswer } from '../../pipeline/answer.ts';
import { edgeHttp, type HttpOutput, jsonHttpResponse } from '../../pipeline/edge-http.ts';
import { failover } from '../../pipeline/failover.ts';
import type { GatewayHttpFacts } from '../../pipeline/host.ts';
import { requestBytes } from '../../pipeline/non-chat.ts';
import type { UsageFacts } from '../../pipeline/observe-usage.ts';
import type { RenderFacts } from '../../pipeline/render.ts';
import { createResolveCandidates, type ModelRequest } from '../../pipeline/resolve-candidates.ts';
import type { GatewayServices, RouteCandidate } from '../../pipeline/services.ts';
import { priceUsage, type SettlementFacts, writeSettlement } from '../../pipeline/settlement.ts';
import { openaiInternalErrorPayload } from '../../shared/openai-error-payload.ts';
import { serializeSseFrame } from '../../shared/sse.ts';
import { type AffinityFacts, createAffinity, createAnalyzeAffinity, isAffinityRoutingFailure, selectChatCandidates } from '../shared/affinity/stages.ts';
import { createEncode, type DeliveryFacts, type DeliveryIntent } from '../shared/encode.ts';
import { type ChatBodyInput, type ChatBodyOutput, type ChatPayloadFacts, enterChatBody } from '../shared/route-body.ts';
import { openaiChatCompletionsTarget } from '../shared/target-picker.ts';
import { compose, defineStage, type Pipeline, type StaticTarget } from '@floway-dev/pipeline';
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
type Rendered = HttpOutput & UsageFacts & RenderFacts;

const parsePayload = defineStage<GatewayHttpFacts, Parsed, Rendered, Rendered>({
  name: 'parsePayload',
  through: {
    request: {
      needs: ['request.http'], consumes: [],
      provides: ['request.model', 'request.openaiChatCompletions', 'request.delivery'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: answerKeys },
  execute: async (facts, next, env) => {
    const payload = JSON.parse(requestBytes(facts['request.http']).utf8()) as OpenAIChatCompletionsPayloadEx;
    const nullableField = payload.prompt_cache_options === null ? 'prompt_cache_options' : payload.user === null ? 'user' : undefined;
    if (nullableField !== undefined) {
      return gatewayAnswer(env, jsonHttpResponse(400, {
        error: {
          message: `Invalid '${nullableField}': expected ${nullableField === 'user' ? 'a string' : 'an object'} when present.`,
          type: 'invalid_request_error',
          param: nullableField,
          code: null,
        },
      }, env.clock()));
    }
    return await next({
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

type BodyTargets = { readonly body: StaticTarget<ChatBodyInput<Api>, ChatBodyOutput<Api>, GatewayServices> };

export const createOpenAIChatCompletionsIngress = (body: Pipeline<ChatBodyInput<Api>, ChatBodyOutput<Api>, GatewayServices>) =>
  compose<GatewayHttpFacts, HttpOutput & SettlementFacts, GatewayServices, BodyTargets>('openaiChatCompletions.ingress', {
    stages: [writeSettlement('chat'), priceUsage, edgeHttp, parsePayload, analyzeAffinity, resolveCandidates, encode, failover, affinity],
    ending: enterChatBody(api),
    targets: { body },
  });

export const openaiChatCompletionsHttpOptions = {
  errorStatus: (): 502 => 502,
  errorBody: (error: unknown) => openaiInternalErrorPayload(toInternalDebugError(error)),
} as const;
