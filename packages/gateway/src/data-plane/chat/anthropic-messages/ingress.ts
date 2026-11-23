import { analyzeAnthropicMessagesAffinity, type AnthropicMessagesAffinityAnalysis, evaluateAnthropicMessagesAffinity } from './affinity/analysis.ts';
import { wrapAnthropicMessagesAffinityEgress } from './affinity/egress.ts';
import type { AnthropicMessagesCountBodyInput, AnthropicMessagesCountBodyOutput } from './body.ts';
import { anthropicMessagesErrorBody, internalAnthropicMessagesErrorPayload } from './errors.ts';
import { edgeHttp, type HttpOutput, jsonHttpResponse } from '../../pipeline/edge-http.ts';
import { failover } from '../../pipeline/failover.ts';
import type { GatewayHttpFacts } from '../../pipeline/host.ts';
import { forwardHttp, header, requestBytes } from '../../pipeline/non-chat.ts';
import { emptyUsageFacts, type UsageFacts, usageResponseKeys } from '../../pipeline/observe-usage.ts';
import { type RenderFacts, renderedNow } from '../../pipeline/render.ts';
import { createResolveCandidates, type ModelRequest } from '../../pipeline/resolve-candidates.ts';
import type { GatewayServices, RouteCandidate } from '../../pipeline/services.ts';
import { priceUsage, type SettlementFacts, writeSettlement } from '../../pipeline/settlement.ts';
import { serializeSseFrame } from '../../shared/sse.ts';
import { type AffinityFacts, createAffinity, createAnalyzeAffinity, selectChatCandidates } from '../shared/affinity/stages.ts';
import { createEncode, type DeliveryFacts } from '../shared/encode.ts';
import { type ChatBodyInput, type ChatBodyOutput, enterChatBody } from '../shared/route-body.ts';
import { serializeAnthropicMessagesStream, shouldSerializeStreamItems } from '../shared/stream-compatibility/index.ts';
import { anthropicMessagesCountTokensTarget, anthropicMessagesGenerateTarget, type ChatTargetPicker } from '../shared/target-picker.ts';
import { compose, defineEnding, defineStage, type Pipeline, type StaticTarget } from '@floway-dev/pipeline';
import { ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE, type AnthropicMessagesPayload, anthropicMessagesProtocolFrameToSSEFrame, collectAnthropicMessagesProtocolEventsToResult, parseAnthropicBetaHeader } from '@floway-dev/protocols/anthropic-messages';
import { sseFrame } from '@floway-dev/protocols/common';

type Parsed = GatewayHttpFacts & ModelRequest & DeliveryFacts & {
  readonly 'request.anthropicMessages': AnthropicMessagesPayload;
  readonly 'request.anthropicBeta': readonly string[];
};
type Rendered = HttpOutput & UsageFacts & RenderFacts;

const parsePayload = (allowsStreaming: boolean) => defineStage<GatewayHttpFacts, Parsed, Rendered, Rendered>({
  name: 'parsePayload',
  through: {
    request: {
      needs: ['request.http'], consumes: [],
      provides: ['request.model', 'request.anthropicMessages', 'request.anthropicBeta', 'request.delivery'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: ['response.http', 'response.render', ...usageResponseKeys] },
  execute: async (facts, next, env) => {
    const http = facts['request.http'];
    const payload = JSON.parse(requestBytes(http).utf8()) as AnthropicMessagesPayload;
    const param = ['anthropic_beta', 'betas'].find(key => Object.hasOwn(payload, key));
    if (param !== undefined) {
      return {
        'response.http': jsonHttpResponse(400, {
          error: {
            message: `${param} in the Anthropic Messages request body is not supported; send Anthropic beta flags with the anthropic-beta HTTP header.`,
            type: 'invalid_request_error',
            param,
          },
        }, env.clock()),
        ...emptyUsageFacts(env),
        ...renderedNow(env, { kind: 'completed' }),
      };
    }
    return await next({
      ...facts,
      'request.model': payload.model,
      'request.anthropicMessages': payload,
      'request.anthropicBeta': parseAnthropicBetaHeader(header(http.headers, 'anthropic-beta')),
      'request.delivery': { stream: allowsStreaming && payload.stream === true },
    });
  },
});

const analyzeAffinity = createAnalyzeAffinity('anthropicMessages', analyzeAnthropicMessagesAffinity);
const resolveCandidates = (picker: ChatTargetPicker, path: string) =>
  createResolveCandidates<RouteCandidate, Parsed & AffinityFacts<AnthropicMessagesAffinityAnalysis>>({
    kind: 'chat',
    sourceApi: path,
    requestNeeds: ['request.affinity', 'request.anthropicMessages'],
    select: (candidates, facts) => selectChatCandidates(
      candidates, picker, facts['request.affinity'], facts['request.anthropicMessages'], evaluateAnthropicMessagesAffinity, facts['request.model'],
    ),
    errorBody: error => anthropicMessagesErrorBody(error.status === 404 ? 'not_found_error' : 'invalid_request_error', error.message),
  });

const affinity = createAffinity('anthropicMessages', {
  evaluate: evaluateAnthropicMessagesAffinity,
  wrap: (source, options, facts) => {
    const flags = new Set(facts['route.candidate'].providerModel.enabledFlags);
    const enabled = shouldSerializeStreamItems(flags, 'anthropicMessages', header(facts['request.http'].headers, 'user-agent') ?? null);
    return wrapAnthropicMessagesAffinityEgress(serializeAnthropicMessagesStream(source, enabled), options);
  },
});
const countAffinity = createAffinity('anthropicMessages', { evaluate: evaluateAnthropicMessagesAffinity });

const encode = createEncode('anthropicMessages', {
  encodeJson: collectAnthropicMessagesProtocolEventsToResult,
  keepAlive: { frame: sseFrame(JSON.stringify({ type: 'ping' }), 'ping') },
  collectFailure: error => ({ status: 502, body: internalAnthropicMessagesErrorPayload(error) }),
  openSse: () => ({
    encode: frame => {
      const output = anthropicMessagesProtocolFrameToSSEFrame(frame);
      const wire = output === null ? null : serializeSseFrame(output);
      if (frame.type === 'event') {
        if (frame.event.type === 'message_stop') return { wire, end: { type: 'completed' } };
        if (frame.event.type === 'error') return { wire, end: { type: 'protocol-error' } };
      }
      return { wire };
    },
    eof: () => ({ type: 'premature-eof', error: new Error(ANTHROPIC_MESSAGES_MISSING_TERMINAL_MESSAGE) }),
    failure: error => {
      // https://github.com/anthropics/anthropic-sdk-typescript/blob/3f13f60335f8bcf91a782785f4f16e4267c999ad/src/resources/shared.ts#L247-L255
      const payload = internalAnthropicMessagesErrorPayload(error);
      const event = { ...payload, error: { ...payload.error, type: 'api_error' } };
      return [serializeSseFrame(sseFrame(JSON.stringify(event), 'error'))];
    },
  }),
});

const encodeCount = defineStage<object, object, HttpOutput, HttpOutput & RenderFacts>({
  name: 'encode',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: { needs: ['response.http'], consumes: [], provides: ['response.http', 'response.render'] },
  },
  execute: async (facts, next, env) => {
    const response = await next(facts);
    return { ...response, 'response.http': forwardHttp(response['response.http'], null), ...renderedNow(env, { kind: 'completed' }) };
  },
});

type GenerateTargets = { readonly body: StaticTarget<ChatBodyInput<'anthropicMessages'>, ChatBodyOutput<'anthropicMessages'>, GatewayServices> };
type CountTargets = { readonly body: StaticTarget<AnthropicMessagesCountBodyInput, AnthropicMessagesCountBodyOutput, GatewayServices> };

const enterCountBody = defineEnding<AnthropicMessagesCountBodyInput, AnthropicMessagesCountBodyOutput, CountTargets>({
  name: 'enterBody',
  request: { needs: ['request.anthropicMessages', 'request.anthropicBeta', 'request.http', 'route.candidate'] },
  into: {
    body: {
      request: { needs: [], consumes: [], provides: [] },
      response: { needs: ['response.http', 'response.targetApi', ...usageResponseKeys], consumes: [], provides: [] },
    },
  },
  execute: async (facts, into) => await into.body(facts),
});

export const createAnthropicMessagesIngress = (body: Pipeline<ChatBodyInput<'anthropicMessages'>, ChatBodyOutput<'anthropicMessages'>, GatewayServices>) =>
  compose<GatewayHttpFacts, HttpOutput & SettlementFacts, GatewayServices, GenerateTargets>('anthropicMessages.ingress', {
    stages: [
      writeSettlement('chat'), priceUsage, edgeHttp, parsePayload(true), analyzeAffinity,
      resolveCandidates(anthropicMessagesGenerateTarget, '/messages'), encode, failover, affinity,
    ],
    ending: enterChatBody('anthropicMessages'),
    targets: { body },
  });

export const createAnthropicMessagesCountIngress = (body: Pipeline<AnthropicMessagesCountBodyInput, AnthropicMessagesCountBodyOutput, GatewayServices>) =>
  compose<GatewayHttpFacts, HttpOutput & SettlementFacts, GatewayServices, CountTargets>('anthropicMessagesCountTokens.ingress', {
    stages: [
      writeSettlement(null), priceUsage, edgeHttp, parsePayload(false), analyzeAffinity,
      resolveCandidates(anthropicMessagesCountTokensTarget, '/messages/count_tokens'), encodeCount, failover, countAffinity,
    ],
    ending: enterCountBody,
    targets: { body },
  });

export const anthropicMessagesHttpOptions = {
  errorStatus: () => 502,
  errorBody: internalAnthropicMessagesErrorPayload,
} as const;
