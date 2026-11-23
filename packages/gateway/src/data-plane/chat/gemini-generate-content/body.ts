import type { GeminiCountEgressOutput } from './egress.ts';
import { gatewayErrorStatus } from './errors.ts';
import { geminiInputErrorBody, geminiInternalErrorBody, geminiJsonBody } from './http-error.ts';
import { stripSafetySettings } from './stages/strip-safety-settings.ts';
import { stripUnsupportedPartFields } from './stages/strip-unsupported-part-fields.ts';
import { stripUnsupportedTools } from './stages/strip-unsupported-tools.ts';
import { suppressThoughtParts } from './stages/suppress-thought-parts.ts';
import { type AnswerFacts, answerKeys, gatewayAnswer } from '../../pipeline/answer.ts';
import { type HttpOutput, jsonHttpResponse } from '../../pipeline/edge-http.ts';
import { readHttpBytes } from '../../pipeline/non-chat.ts';
import { emptyUsageFacts, type UsageFacts, usageResponseKeys } from '../../pipeline/observe-usage.ts';
import type { GatewayServices } from '../../pipeline/services.ts';
import type { AnthropicMessagesCountBodyInput, AnthropicMessagesCountBodyOutput } from '../anthropic-messages/body.ts';
import { type ChatBodyInput, type ChatBodyOutput, type ChatBodyTargets, type ChatEgressInput, createGeminiGenerateContentRouteBody } from '../shared/route-body.ts';
import { SidecarDomain } from '../shared/sidecar-codec.ts';
import { geminiGenerateContentCountTokensTarget, geminiGenerateContentGenerateTarget, pickTarget, type TargetRequest } from '../shared/target-picker.ts';
import type { HttpResponseFacts } from '@floway-dev/http';
import { compose, defineEnding, type StaticTarget } from '@floway-dev/pipeline';
import type { ChatTargetApi } from '@floway-dev/provider';
import { routeGeminiGenerateContentViaAnthropicMessages } from '@floway-dev/translate';

type Api = 'geminiGenerateContent';
const shapeStages = [stripUnsupportedPartFields, stripUnsupportedTools, stripSafetySettings];

export const createGeminiGenerateContentBody = (targets: ChatBodyTargets<Api>) =>
  compose<ChatBodyInput<Api>, ChatBodyOutput<Api>, GatewayServices, ChatBodyTargets<Api>>('geminiGenerateContent.body', {
    stages: [pickTarget(geminiGenerateContentGenerateTarget), ...shapeStages, suppressThoughtParts],
    ending: createGeminiGenerateContentRouteBody(geminiInputErrorBody),
    targets,
  });

export interface GeminiCountBodyOutput extends HttpOutput, UsageFacts, AnswerFacts {
  readonly 'response.targetApi'?: ChatTargetApi;
}

type GeminiCountBodyTargets = {
  readonly egress: StaticTarget<ChatEgressInput<Api>, GeminiCountEgressOutput, GatewayServices>;
  readonly messagesCount: StaticTarget<AnthropicMessagesCountBodyInput, AnthropicMessagesCountBodyOutput, GatewayServices>;
};

const tokenCount = (value: unknown) => {
  if (value === null || typeof value !== 'object') return undefined;
  if ('input_tokens' in value && typeof value.input_tokens === 'number') return value.input_tokens;
  if ('total_tokens' in value && typeof value.total_tokens === 'number') return value.total_tokens;
};

const reshapeCount = async (http: HttpResponseFacts, now: number): Promise<HttpResponseFacts> => {
  const { status, body } = http;
  if (body === null && (status === 204 || status === 205 || status === 304)) return http;
  const text = (await readHttpBytes(body)).utf8();
  if (status !== 200) {
    return geminiJsonBody(http, {
      error: { code: status, message: text || 'Upstream token counting request failed.', status: gatewayErrorStatus(status) },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A non-JSON upstream count shares the invalid-count response.
  }
  const totalTokens = tokenCount(parsed);
  return totalTokens === undefined
    ? jsonHttpResponse(502, geminiInternalErrorBody(502, new Error('Invalid upstream token counting response.')), now)
    : geminiJsonBody(http, { totalTokens });
};

type CountRequest = ChatBodyInput<Api> & TargetRequest<ReturnType<typeof geminiGenerateContentCountTokensTarget.pick>>;

const routeCount = defineEnding<CountRequest, GeminiCountBodyOutput, GeminiCountBodyTargets, Pick<GatewayServices, 'sidecarCodecs'>>({
  name: 'routeBody',
  request: { needs: ['request.geminiGenerateContent', 'route.candidate', 'route.targetApi'] },
  into: {
    egress: {
      request: { needs: [], consumes: ['request.geminiGenerateContent'], provides: ['request.payload'] },
      response: { needs: ['response.http', 'response.targetApi', 'response.source'], consumes: [], provides: usageResponseKeys },
    },
    messagesCount: {
      request: {
        needs: [], consumes: ['request.geminiGenerateContent'], provides: ['request.anthropicMessages', 'request.anthropicBeta'],
      },
      response: { needs: ['response.http', 'response.targetApi', 'response.source', ...usageResponseKeys], consumes: [], provides: ['response.http'] },
    },
  },
  return: { provides: [...answerKeys, 'response.performance.operation'] },
  execute: async ({ 'request.geminiGenerateContent': payload, ...facts }, into, env) => {
    if (facts['route.targetApi'] === 'geminiGenerateContent') {
      const response = await into.egress({ ...facts, 'request.payload': payload });
      return { ...response, ...emptyUsageFacts(env) };
    }
    const trip = await routeGeminiGenerateContentViaAnthropicMessages(payload, {
      sidecarCodec: env.services.sidecarCodecs.codecFor(SidecarDomain.TranslatedAssistantTurn),
      fallbackMaxOutputTokens: facts['route.candidate'].limits.max_output_tokens,
    });
    if (trip.type === 'input-error') {
      return gatewayAnswer(env, jsonHttpResponse(400, geminiInputErrorBody(trip), env.clock()), { 'response.performance.operation': 'chat' as const });
    }
    const { stream: _stream, ...messages } = trip.target;
    const response = await into.messagesCount({
      ...facts, 'request.anthropicMessages': messages, 'request.anthropicBeta': [],
    });
    return { ...response, 'response.http': await reshapeCount(response['response.http'], env.clock()) };
  },
});

export const createGeminiGenerateContentCountBody = (targets: GeminiCountBodyTargets) =>
  compose<ChatBodyInput<Api>, GeminiCountBodyOutput, GatewayServices, GeminiCountBodyTargets>('geminiGenerateContentCountTokens.body', {
    stages: [pickTarget(geminiGenerateContentCountTokensTarget), ...shapeStages],
    ending: routeCount,
    targets,
  });
