import { decodeGeminiGenerateContentAffinity, evaluateGeminiGenerateContentAffinity, type GeminiGenerateContentAffinityAnalysis, scoreGeminiGenerateContentAffinity } from './affinity/analysis.ts';
import { wrapGeminiGenerateContentAffinityEgress } from './affinity/egress.ts';
import type { GeminiCountBodyOutput } from './body.ts';
import { geminiGenerateContentRpcErrorPayload, googleRpcHttpStatusCode, isGeminiGenerateContentErrorResponse } from './errors.ts';
import { geminiInternalErrorBody, normalizeGeminiFailure } from './http-error.ts';
import { edgeHttp, type HttpOutput } from '../../pipeline/edge-http.ts';
import { failover } from '../../pipeline/failover.ts';
import type { GatewayHttpFacts } from '../../pipeline/host.ts';
import { forwardHttp, requestBytes } from '../../pipeline/non-chat.ts';
import { usageResponseKeys } from '../../pipeline/observe-usage.ts';
import { type RenderFacts, renderedNow } from '../../pipeline/render.ts';
import { createResolveCandidates, type ModelRequest } from '../../pipeline/resolve-candidates.ts';
import type { GatewayServices, RouteCandidate } from '../../pipeline/services.ts';
import { priceUsage, type SettlementFacts, writeSettlement } from '../../pipeline/settlement.ts';
import { serializeSseFrame } from '../../shared/sse.ts';
import { type AffinityFacts, createAffinity, createAnalyzeAffinity, selectChatCandidates } from '../shared/affinity/stages.ts';
import { createEncode, type DeliveryFacts, type DeliveryIntent } from '../shared/encode.ts';
import { type ChatBodyInput, type ChatBodyOutput, type ChatPayloadFacts, enterChatBody } from '../shared/route-body.ts';
import { type ChatTargetPicker, geminiGenerateContentCountTokensTarget, geminiGenerateContentGenerateTarget } from '../shared/target-picker.ts';
import { compose, defineEnding, defineStage, type Pipeline, type StaticTarget } from '@floway-dev/pipeline';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import {
  collectGeminiGenerateContentProtocolEventsToResult,
  createGeminiGenerateContentCandidateCompletion,
  GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE,
  type GeminiCountTokensPayload,
  type GeminiGenerateContentPayload,
  geminiGenerateContentProtocolFrameToSSEFrame,
  type GeminiGenerateContentStreamEvent,
  isGeminiGenerateContentErrorEvent,
  isGeminiGenerateContentTerminalEvent,
} from '@floway-dev/protocols/gemini-generate-content';

type Api = 'geminiGenerateContent';
const api: Api = 'geminiGenerateContent';
type GeminiAction = 'generateContent' | 'streamGenerateContent' | 'countTokens';

export type GeminiIngressInput = GatewayHttpFacts & {
  readonly 'request.geminiAction': { readonly action: GeminiAction; readonly model: string };
};
type Parsed = GeminiIngressInput & ModelRequest & ChatPayloadFacts<Api> & DeliveryFacts;

const parseCountPayload = (body: GeminiCountTokensPayload): GeminiGenerateContentPayload => {
  if (body.generateContentRequest !== undefined) return body.generateContentRequest;
  return { contents: body.contents ?? [] };
};

const parsePayload = defineStage<GeminiIngressInput, Parsed, HttpOutput, HttpOutput>({
  name: 'parsePayload',
  through: {
    request: {
      needs: ['request.http', 'request.geminiAction'], consumes: [],
      provides: ['request.model', 'request.geminiGenerateContent', 'request.delivery'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    const { action, model } = facts['request.geminiAction'];
    const raw: unknown = JSON.parse(requestBytes(facts['request.http']).utf8());
    const payload = action === 'countTokens' ? parseCountPayload(raw as GeminiCountTokensPayload) : raw as GeminiGenerateContentPayload;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) throw new TypeError('Expected a Gemini request object');
    return await next({
      ...facts, 'request.model': model, 'request.geminiGenerateContent': { ...payload, model },
      'request.delivery': { stream: action === 'streamGenerateContent' },
    });
  },
});

const analyzeAffinity = createAnalyzeAffinity(api, decodeGeminiGenerateContentAffinity);
const terminal = (frame: ProtocolFrame<GeminiGenerateContentStreamEvent>): 'completed' | 'protocol-error' | undefined => {
  if (frame.type === 'done') return 'completed';
  if (isGeminiGenerateContentErrorEvent(frame.event)) return 'protocol-error';
  if (isGeminiGenerateContentTerminalEvent(frame.event)) return 'completed';
};

const affinity = createAffinity(api, {
  evaluate: evaluateGeminiGenerateContentAffinity,
  wrap: wrapGeminiGenerateContentAffinityEgress,
  observeCompletion: () => {
    const completion = createGeminiGenerateContentCandidateCompletion();
    let end: ReturnType<typeof terminal>;
    return {
      frame: frame => {
        if (end !== undefined) return;
        end = terminal(frame);
        if (end === undefined && frame.type === 'event') completion.observe(frame.event);
      },
      completed: () => end === 'completed' || (end === undefined && completion.isComplete()),
    };
  },
});
const countAffinity = createAffinity(api, { evaluate: evaluateGeminiGenerateContentAffinity });

const resolveCandidates = (picker: ChatTargetPicker, sourceApi: string, unsupportedMessage: (model: string) => string) =>
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

const caughtGeminiError = (error: unknown) =>
  error instanceof Error && isGeminiGenerateContentErrorResponse(error.cause) ? error.cause : undefined;

const encode = createEncode<Api, DeliveryIntent>(api, {
  encodeJson: collectGeminiGenerateContentProtocolEventsToResult,
  encodeScalar: async ({ 'response.http': http, 'response.source': source }) =>
    source === 'gateway' ? forwardHttp(http, null) : await normalizeGeminiFailure(http),
  collectFailure: error => {
    const rpc = caughtGeminiError(error);
    return rpc === undefined ? { status: 502, body: geminiInternalErrorBody(502, error) }
      : { status: googleRpcHttpStatusCode(rpc.error.code), body: rpc };
  },
  openSse: () => {
    const completion = createGeminiGenerateContentCandidateCompletion();
    return {
      encode: frame => {
        const output = geminiGenerateContentProtocolFrameToSSEFrame(frame);
        const wire = output === null ? null : serializeSseFrame(output);
        const end = terminal(frame);
        if (end !== undefined) return { wire, end: { type: end } };
        if (frame.type === 'event') completion.observe(frame.event);
        return { wire };
      },
      eof: () => completion.isComplete() ? { type: 'completed' }
        : { type: 'premature-eof', error: new Error(GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE) },
      failure: error => {
        const event = eventFrame(caughtGeminiError(error) ?? geminiInternalErrorBody(500, error));
        const wire = geminiGenerateContentProtocolFrameToSSEFrame(event);
        if (wire === null) throw new Error('Gemini error event produced no SSE frame');
        return [serializeSseFrame(wire)];
      },
    };
  },
});

const encodeCount = defineStage<object, object, HttpOutput, HttpOutput & RenderFacts>({
  name: 'encode',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: { needs: ['response.http'], consumes: [], provides: ['response.http', 'response.render'] },
  },
  execute: async (facts, next, env) => {
    const response = await next(facts);
    return { ...response, 'response.http': forwardHttp(response['response.http']), ...renderedNow(env, { kind: 'completed' }) };
  },
});

type BodyTargets = { readonly body: StaticTarget<ChatBodyInput<Api>, ChatBodyOutput<Api>, GatewayServices> };
type CountTargets = { readonly body: StaticTarget<ChatBodyInput<Api>, GeminiCountBodyOutput, GatewayServices> };
type IngressOutput = HttpOutput & SettlementFacts;

const enterCountBody = defineEnding<ChatBodyInput<Api>, GeminiCountBodyOutput, CountTargets>({
  name: 'enterBody',
  request: { needs: ['request.geminiGenerateContent', 'request.http', 'route.candidate'] },
  into: {
    body: {
      request: { needs: [], consumes: [], provides: [] },
      response: { needs: ['response.http', 'response.source', ...usageResponseKeys], consumes: [], provides: [] },
    },
  },
  execute: async (facts, into) => await into.body(facts),
});

export const createGeminiGenerateContentIngress = (body: Pipeline<ChatBodyInput<Api>, ChatBodyOutput<Api>, GatewayServices>) =>
  compose<GeminiIngressInput, IngressOutput, GatewayServices, BodyTargets>('geminiGenerateContent.ingress', {
    stages: [
      writeSettlement('chat'), priceUsage, edgeHttp, parsePayload, analyzeAffinity,
      resolveCandidates(geminiGenerateContentGenerateTarget, ':generateContent', model => `Model ${model} does not support the Gemini generateContent endpoint.`),
      encode, failover, affinity,
    ],
    ending: enterChatBody(api),
    targets: { body },
  });

export const createGeminiGenerateContentCountIngress = (body: Pipeline<ChatBodyInput<Api>, GeminiCountBodyOutput, GatewayServices>) =>
  compose<GeminiIngressInput, IngressOutput, GatewayServices, CountTargets>('geminiGenerateContentCountTokens.ingress', {
    stages: [
      writeSettlement(null), priceUsage, edgeHttp, parsePayload, analyzeAffinity,
      resolveCandidates(geminiGenerateContentCountTokensTarget, ':countTokens', model => `Model ${model} does not support countTokens.`),
      encodeCount, failover, countAffinity,
    ],
    ending: enterCountBody,
    targets: { body },
  });

export const geminiGenerateContentHttpOptions = {
  errorStatus: (): 500 => 500,
  errorBody: (error: unknown) => geminiInternalErrorBody(500, error),
} as const;
