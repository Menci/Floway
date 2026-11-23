import { gatewayErrorStatus, geminiGenerateContentRpcErrorPayload, googleRpcHttpStatusCode, isGeminiGenerateContentErrorResponse } from './errors.ts';
import { geminiInputErrorBody, geminiInternalErrorBody, geminiJsonBody } from './http-error.ts';
import { type GeminiCompletionFacts, observeGeminiCompletion } from './stages/observe-completion.ts';
import { stripSafetySettings } from './stages/strip-safety-settings.ts';
import { stripUnsupportedPartFields } from './stages/strip-unsupported-part-fields.ts';
import { stripUnsupportedTools } from './stages/strip-unsupported-tools.ts';
import { suppressThoughtParts } from './stages/suppress-thought-parts.ts';
import { type HttpOutput, jsonHttpResponse } from '../../pipeline/edge-http.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import type { AnthropicMessagesCountBodyInput, AnthropicMessagesCountBodyOutput } from '../anthropic-messages/body.ts';
import { removeFact } from '../shared/remove-fact.ts';
import { type ChatBodyInput, type ChatBodyOutput, type ChatBodyTargets, type ChatEgressInput, createGeminiGenerateContentRouteBody } from '../shared/route-body.ts';
import { SidecarDomain } from '../shared/sidecar-codec.ts';
import { geminiGenerateContentCountTokensTarget, geminiGenerateContentGenerateTarget, pickTarget, type TargetRequest } from '../shared/target-picker.ts';
import type { HttpResponseFacts } from '@floway-dev/http';
import { compose, defineEnding, defineStage, type FactValue, type StaticTarget } from '@floway-dev/pipeline';
import { type HttpOutcome, type ProviderGeminiCountTokensOutput, readHttpBody } from '@floway-dev/provider';
import { routeGeminiGenerateContentViaAnthropicMessages } from '@floway-dev/translate';

type Api = 'geminiGenerateContent';
const shapeStages = [stripUnsupportedPartFields, stripUnsupportedTools, stripSafetySettings];
const entry = [
  'request.http', 'request.auth.apiKeyId', 'request.auth.user', 'request.route.upstreamIds', 'request.route.randomizeUpstreams',
  'request.route.runtimeLocation', 'request.geminiGenerateContent', 'route.candidate',
] as const;
const generateExit = ['response.http', 'response.geminiGenerateContent'] as const;

const normalizeError = defineStage<object, object, ChatBodyOutput<Api>, ChatBodyOutput<Api>>({
  name: 'normalizeError',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: { needs: generateExit, consumes: [], provides: generateExit },
  },
  execute: async (facts, scope) => {
    const response = await scope.next(facts);
    const http = response['response.http'];
    const outcome = response['response.geminiGenerateContent'];
    if (outcome.kind !== 'error' || outcome.source !== 'upstream' || http.transportError !== undefined) return response;
    if (isGeminiGenerateContentErrorResponse(outcome.error)) {
      const status = googleRpcHttpStatusCode(outcome.error.error.code);
      return { ...response, 'response.http': status === http.status ? http : { ...http, status, statusText: '' } };
    }
    const status = gatewayErrorStatus(http.status) === 'INTERNAL' ? 500 : http.status;
    const error = geminiGenerateContentRpcErrorPayload(status, JSON.stringify(outcome.error) ?? 'Upstream Gemini generateContent request failed.');
    return {
      ...response,
      'response.http': status === http.status ? http : { ...http, status, statusText: '' },
      'response.geminiGenerateContent': { ...outcome, error },
    };
  },
});

export type GeminiGenerateContentBodyOutput = HttpOutput & GeminiCompletionFacts;

export const createGeminiGenerateContentBody = (targets: ChatBodyTargets<Api>) =>
  compose<ChatBodyInput<Api> & GeminiGenerateContentBodyOutput, GatewayServices>()('geminiGenerateContent.body', {
    entry, exit: generateExit,
    stages: [pickTarget(geminiGenerateContentGenerateTarget), observeGeminiCompletion, normalizeError, ...shapeStages, suppressThoughtParts],
    ending: createGeminiGenerateContentRouteBody(geminiInputErrorBody),
    targets,
  });

export const geminiCountKey = 'response.geminiGenerateContentCountTokens';
const messagesCountKey = 'response.anthropicMessagesCountTokens';
const countExit = ['response.http', geminiCountKey] as const;

export interface GeminiCountBodyOutput extends HttpOutput {
  readonly [geminiCountKey]: HttpOutcome;
}

type GeminiCountBodyTargets = {
  readonly egress: StaticTarget<ChatEgressInput<Api>, ProviderGeminiCountTokensOutput, GatewayServices>;
  readonly messagesCount: StaticTarget<AnthropicMessagesCountBodyInput, AnthropicMessagesCountBodyOutput, GatewayServices>;
};

const tokenCount = (value: unknown) => {
  if (value === null || typeof value !== 'object') return undefined;
  if ('input_tokens' in value && typeof value.input_tokens === 'number') return value.input_tokens;
  if ('total_tokens' in value && typeof value.total_tokens === 'number') return value.total_tokens;
};

const countResult = (http: HttpResponseFacts, outcome: HttpOutcome): GeminiCountBodyOutput => ({
  'response.http': http,
  [geminiCountKey]: outcome,
});

const countError = (http: HttpResponseFacts, source: 'upstream' | 'local', error: FactValue): GeminiCountBodyOutput =>
  countResult(http, { kind: 'error', source, error });

const reshapeCount = async (http: HttpResponseFacts, outcome: HttpOutcome): Promise<GeminiCountBodyOutput> => {
  const { status, body } = http;
  if (http.transportError !== undefined || (body === null && (status === 204 || status === 205 || status === 304))) return countResult(http, outcome);
  const contents = await readHttpBody(body);
  if (!contents.ok) {
    return countError({ ...http, status: 502, statusText: '', body: null, transportError: contents.error }, 'upstream', contents.error);
  }
  const text = contents.bytes.utf8();
  if (outcome.kind === 'error' || status !== 200) {
    const error = {
      error: { code: status, message: text || 'Upstream token counting request failed.', status: gatewayErrorStatus(status) },
    };
    return countError(geminiJsonBody(http, error), outcome.kind === 'error' ? outcome.source : 'upstream', error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const totalTokens = tokenCount(parsed);
  if (totalTokens !== undefined) return countResult(geminiJsonBody(http, { totalTokens }), outcome);
  const error = geminiInternalErrorBody(502, new Error('Invalid upstream token counting response.'));
  return countError(geminiJsonBody(http, error, 502), 'upstream', error);
};

type CountRequest = ChatBodyInput<Api> & TargetRequest<'geminiGenerateContent' | 'anthropicMessages'>;

const routeCountBody = defineEnding<CountRequest, GeminiCountBodyOutput, GeminiCountBodyTargets, Pick<GatewayServices, 'sidecarCodecs'>>({
  name: 'routeBody',
  request: { needs: ['request.geminiGenerateContent', 'route.candidate', 'route.targetApi'] },
  into: {
    egress: {
      request: { needs: [], consumes: ['request.geminiGenerateContent'], provides: ['request.payload'] },
      response: { needs: ['response.http', 'response.modelKey', geminiCountKey], consumes: ['response.modelKey'], provides: [] },
    },
    messagesCount: {
      request: {
        needs: [], consumes: ['request.geminiGenerateContent'], provides: ['request.anthropicMessages', 'request.anthropicBeta'],
      },
      response: { needs: ['response.http', messagesCountKey], consumes: [messagesCountKey], provides: countExit },
    },
  },
  return: { provides: countExit },
  execute: async ({ 'request.geminiGenerateContent': payload, ...facts }, scope) => {
    const targetApi = facts['route.targetApi'];
    if (targetApi === 'geminiGenerateContent') {
      const response = await scope.into.egress({ ...facts, 'route.targetApi': targetApi, 'request.payload': payload });
      return removeFact<GeminiCountBodyOutput, 'response.modelKey'>(response, 'response.modelKey');
    }
    const trip = await routeGeminiGenerateContentViaAnthropicMessages(payload, {
      sidecarCodec: scope.services.sidecarCodecs.codecFor(SidecarDomain.TranslatedAssistantTurn),
      fallbackMaxOutputTokens: facts['route.candidate'].limits.max_output_tokens,
    });
    if (trip.type === 'input-error') {
      const error = geminiInputErrorBody(trip);
      return countError(jsonHttpResponse(400, error, scope.clock()), 'local', error);
    }
    const { stream: _stream, ...messages } = trip.target;
    const response = await scope.into.messagesCount({
      ...facts, 'request.anthropicMessages': messages, 'request.anthropicBeta': [],
    });
    return await reshapeCount(response['response.http'], response[messagesCountKey]);
  },
});

export const createGeminiGenerateContentCountBody = (targets: GeminiCountBodyTargets) =>
  compose<ChatBodyInput<Api> & GeminiCountBodyOutput, GatewayServices>()('geminiGenerateContentCountTokens.body', {
    entry, exit: countExit,
    stages: [pickTarget(geminiGenerateContentCountTokensTarget), ...shapeStages],
    ending: routeCountBody,
    targets,
  });
