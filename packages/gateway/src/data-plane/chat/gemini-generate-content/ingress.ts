import { decodeGeminiGenerateContentAffinity, evaluateGeminiGenerateContentAffinity, type GeminiGenerateContentAffinityAnalysis, scoreGeminiGenerateContentAffinity } from './affinity/analysis.ts';
import { wrapGeminiGenerateContentAffinityEgress } from './affinity/egress.ts';
import { geminiCountKey, type GeminiCountBodyOutput, type GeminiGenerateContentBodyOutput } from './body.ts';
import { geminiGenerateContentRpcErrorPayload, googleRpcHttpStatusCode, isGeminiGenerateContentErrorResponse } from './errors.ts';
import { geminiInternalErrorBody, geminiJsonBody } from './http-error.ts';
import { type GeminiCompletionFacts, geminiTerminal } from './stages/observe-completion.ts';
import { edgeHttp, type HttpDeliveryFacts, type HttpOutput, jsonHttpResponse, stripFlowayAuth } from '../../pipeline/edge-http.ts';
import { createFailover } from '../../pipeline/failover.ts';
import { GATEWAY_HTTP_ENTRY, type GatewayHttpFacts, isUploadError } from '../../pipeline/host.ts';
import { forwardHttp, requestBytes } from '../../pipeline/non-chat.ts';
import { localHttpAnswer, type RenderFacts, renderedNow } from '../../pipeline/render.ts';
import { createResolveCandidates, type ModelRequest } from '../../pipeline/resolve-candidates.ts';
import type { GatewayServices, RouteCandidate } from '../../pipeline/services.ts';
import { serializeSseFrame } from '../../shared/sse.ts';
import { type AffinityFacts, createAffinity, createAnalyzeAffinity, selectChatCandidates } from '../shared/affinity/stages.ts';
import { createEncode, type DeliveryFacts, type DeliveryIntent, transportErrorForDisplay } from '../shared/encode.ts';
import { type ChatBodyInput, type ChatPayloadFacts, enterChatBody } from '../shared/route-body.ts';
import { type ChatTargetPicker, geminiGenerateContentCountTokensTarget, geminiGenerateContentGenerateTarget } from '../shared/target-picker.ts';
import { compose, defineEnding, defineStage, type Pipeline, type StaticTarget } from '@floway-dev/pipeline';
import { eventFrame } from '@floway-dev/protocols/common';
import {
  collectGeminiGenerateContentProtocolEventsToResult,
  GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE,
  type GeminiCountTokensPayload,
  type GeminiGenerateContentPayload,
  geminiGenerateContentProtocolFrameToSSEFrame,
  type GeminiGenerateContentStreamEvent,
} from '@floway-dev/protocols/gemini-generate-content';

type Api = 'geminiGenerateContent';
const api: Api = 'geminiGenerateContent';
type GeminiAction = 'generateContent' | 'streamGenerateContent' | 'countTokens';

export type GeminiIngressInput = GatewayHttpFacts & {
  readonly 'request.geminiAction': { readonly action: GeminiAction; readonly model: string };
};
type Parsed = GeminiIngressInput & ModelRequest & ChatPayloadFacts<Api> & DeliveryFacts;
type Rendered = HttpOutput & RenderFacts;
type IngressOutput = Rendered & HttpDeliveryFacts;
const rendered = ['response.http', 'response.render'] as const;
const entry = [...GATEWAY_HTTP_ENTRY, 'request.geminiAction'] as const;
const exit = [...rendered, 'response.delivery'] as const;

const isObject = (value: unknown): value is object =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const parsePayload = defineStage<GeminiIngressInput, Parsed, Rendered, Rendered>({
  name: 'parsePayload',
  through: {
    request: {
      needs: ['request.http', 'request.geminiAction'], consumes: [],
      provides: ['request.model', 'request.geminiGenerateContent', 'request.delivery'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: { provides: rendered },
  execute: async (facts, scope) => {
    const { action, model } = facts['request.geminiAction'];
    const http = facts['request.http'];
    if (isUploadError(http.body)) {
      return localHttpAnswer(scope, jsonHttpResponse(500, geminiInternalErrorBody(500, transportErrorForDisplay(http.body.error)), scope.clock()));
    }
    const badInput = (message: string) => localHttpAnswer(scope, jsonHttpResponse(400, geminiGenerateContentRpcErrorPayload(400, message), scope.clock()));
    let raw: unknown;
    try {
      raw = JSON.parse(requestBytes(http).utf8());
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return badInput(error.message);
    }
    if (!isObject(raw)) return badInput('Expected a Gemini request object');
    let payload: GeminiGenerateContentPayload;
    if (action === 'countTokens') {
      const { generateContentRequest, contents } = raw as GeminiCountTokensPayload;
      if (generateContentRequest !== undefined && !isObject(generateContentRequest)) return badInput('Expected a Gemini request object');
      payload = generateContentRequest ?? { contents: contents ?? [] };
    } else {
      payload = raw as GeminiGenerateContentPayload;
    }
    return await scope.next({
      ...facts, 'request.model': model, 'request.geminiGenerateContent': { ...payload, model },
      'request.delivery': { stream: action === 'streamGenerateContent' },
    });
  },
});

const analyzeAffinity = createAnalyzeAffinity(api, decodeGeminiGenerateContentAffinity);

const affinity = createAffinity(api, {
  evaluate: evaluateGeminiGenerateContentAffinity,
  wrap: wrapGeminiGenerateContentAffinityEgress,
});
const countAffinity = createAffinity(api, { evaluate: evaluateGeminiGenerateContentAffinity });

const resolveChatCandidates = (picker: ChatTargetPicker, sourceApi: string, unsupportedMessage: (model: string) => string) =>
  createResolveCandidates<RouteCandidate, Parsed & AffinityFacts<GeminiGenerateContentAffinityAnalysis>>({
    kind: 'chat',
    sourceApi,
    unsupportedMessage,
    requestNeeds: ['request.affinity', 'request.geminiGenerateContent'],
    select: (candidates, facts) => selectChatCandidates(
      candidates, picker, facts['request.affinity'], facts['request.geminiGenerateContent'], scoreGeminiGenerateContentAffinity, facts['request.model'],
    ),
    errorBody: error => geminiGenerateContentRpcErrorPayload(error.status, error.message),
  });

const resolveCandidates = resolveChatCandidates(geminiGenerateContentGenerateTarget, ':generateContent', model => `Model ${model} does not support the Gemini generateContent endpoint.`);
const resolveCountCandidates = resolveChatCandidates(geminiGenerateContentCountTokensTarget, ':countTokens', model => `Model ${model} does not support countTokens.`);
const failover = createFailover('response.geminiGenerateContent');
const countFailover = createFailover(geminiCountKey);

const caughtGeminiError = (error: unknown) =>
  error instanceof Error && isGeminiGenerateContentErrorResponse(error.cause) ? error.cause : undefined;

const encode = createEncode<Api, DeliveryIntent, GeminiGenerateContentStreamEvent, GeminiCompletionFacts>(api, {
  encodeJson: collectGeminiGenerateContentProtocolEventsToResult,
  contentCompletion: {
    needs: [],
    read: ({ 'response.geminiGenerateContent': outcome }) => outcome.kind === 'stream' ? outcome.contentCompletion : undefined,
  },
  transportError: error => ({ status: 500, body: geminiInternalErrorBody(500, error) }),
  collectFailure: error => {
    const rpc = caughtGeminiError(error);
    return rpc === undefined ? { status: 502, body: geminiInternalErrorBody(502, error) }
      : { status: googleRpcHttpStatusCode(rpc.error.code), body: rpc };
  },
  openSse: () => ({
    encode: frame => {
      const output = geminiGenerateContentProtocolFrameToSSEFrame(frame);
      const wire = output === null ? null : serializeSseFrame(output);
      const end = geminiTerminal(frame);
      return end === undefined ? { wire } : { wire, end: { type: end } };
    },
    eof: complete => complete ? { type: 'completed' }
      : { type: 'premature-eof', error: new Error(GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE) },
    failure: error => {
      const event = eventFrame(caughtGeminiError(error) ?? geminiInternalErrorBody(500, error));
      const wire = geminiGenerateContentProtocolFrameToSSEFrame(event);
      if (wire === null) throw new Error('Gemini error event produced no SSE frame');
      return [serializeSseFrame(wire)];
    },
  }),
});

const encodeCount = defineStage<object, object, GeminiCountBodyOutput, Rendered>({
  name: 'encode',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: { needs: ['response.http', geminiCountKey], consumes: [geminiCountKey], provides: rendered },
  },
  execute: async (facts, scope) => {
    const { [geminiCountKey]: outcome, ...response } = await scope.next(facts);
    const http = response['response.http'];
    const renderedHttp = outcome.kind === 'error' && http.transportError !== undefined
      ? geminiJsonBody(http, geminiInternalErrorBody(500, transportErrorForDisplay(http.transportError)), 500)
      : forwardHttp(http);
    return { ...response, 'response.http': renderedHttp, ...renderedNow(scope, { kind: 'completed' }) };
  },
});

type CountTargets = { readonly body: StaticTarget<ChatBodyInput<Api>, GeminiCountBodyOutput, GatewayServices> };

const enterCountBody = defineEnding<ChatBodyInput<Api>, GeminiCountBodyOutput, CountTargets>({
  name: 'enterBody',
  request: { needs: ['request.geminiGenerateContent', 'request.http', 'route.candidate'] },
  into: {
    body: {
      request: { needs: [], consumes: [], provides: [] },
      response: { needs: ['response.http', geminiCountKey], consumes: [], provides: [] },
    },
  },
  execute: async (facts, scope) => await scope.into.body(facts),
});

export const createGeminiGenerateContentIngress = (body: Pipeline<ChatBodyInput<Api>, GeminiGenerateContentBodyOutput, GatewayServices>) =>
  compose<GeminiIngressInput & IngressOutput, GatewayServices>()('geminiGenerateContent.ingress', {
    entry, exit,
    stages: [edgeHttp, stripFlowayAuth, parsePayload, analyzeAffinity, resolveCandidates, encode, failover, affinity],
    ending: enterChatBody(api),
    targets: { body },
  });

export const createGeminiGenerateContentCountIngress = (body: Pipeline<ChatBodyInput<Api>, GeminiCountBodyOutput, GatewayServices>) =>
  compose<GeminiIngressInput & IngressOutput, GatewayServices>()('geminiGenerateContentCountTokens.ingress', {
    entry, exit,
    stages: [edgeHttp, stripFlowayAuth, parsePayload, analyzeAffinity, resolveCountCandidates, encodeCount, countFailover, countAffinity],
    ending: enterCountBody,
    targets: { body },
  });

export const geminiGenerateContentHttpOptions = {
  errorStatus: (): 500 => 500,
  errorBody: (error: unknown) => geminiInternalErrorBody(500, error),
} as const;
