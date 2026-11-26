import { geminiGenerateContentRpcErrorPayload } from '../chat/gemini-generate-content/errors.ts';
import { stripUnsupportedPartFieldsFromPayload } from '../chat/gemini-generate-content/stages/strip-unsupported-part-fields.ts';
import { stripUnsupportedToolsFromPayload } from '../chat/gemini-generate-content/stages/strip-unsupported-tools.ts';
import { SidecarDomain } from '../chat/shared/sidecar-codec.ts';
import { localResponseHead } from '../pipeline/encode.ts';
import { defineStage } from '../pipeline/facts.ts';
import { deleteHeader } from '@floway-dev/http';
import { routeGeminiGenerateContentViaAnthropicMessages } from '@floway-dev/translate';

const requestNeeds = ['request.http', 'provider.model', 'request.geminiGenerateContentCountTokens'] as const;
const responseNeeds = ['response.http', 'response.geminiGenerateContentCountTokens'] as const;
const observations = ['response.usage?', 'response.performance?'] as const;

export const translateGeminiCountTokens = defineStage({
  name: 'geminiGenerateContentCountTokens.route-provider',
  request: { needs: ['request.auth.apiKeyId', 'serve.runtimeLocation', 'provider.upstream', 'request.aliasRules?', ...requestNeeds] },
  return: { provides: responseNeeds },
  into: {
    geminiGenerateContent: {
      request: { needs: requestNeeds, provides: [], consumes: [] },
      response: { needs: [...responseNeeds, ...observations], provides: [], consumes: [] },
    },
    anthropicMessages: {
      request: {
        needs: [...requestNeeds, 'request.aliasRules?'],
        provides: ['request.http', 'request.anthropicMessagesCountTokens'],
        consumes: ['request.geminiGenerateContentCountTokens'],
      },
      response: {
        needs: ['response.http', 'response.anthropicMessagesCountTokens', ...observations],
        provides: responseNeeds,
        consumes: ['response.anthropicMessagesCountTokens'],
      },
    },
  },
  async execute(facts, scope) {
    const candidate = facts['provider.model'];
    if (candidate.endpoints.geminiGenerateContent !== undefined) {
      return await scope.into.geminiGenerateContent(facts);
    }

    const {
      'request.geminiGenerateContentCountTokens': { generateContentRequest, contents },
      'request.http': http,
      ...request
    } = facts;
    const { safetySettings: _safetySettings, ...payload } = generateContentRequest ?? { contents: contents ?? [] };
    const cleaned = stripUnsupportedPartFieldsFromPayload(stripUnsupportedToolsFromPayload(payload));
    const trip = await routeGeminiGenerateContentViaAnthropicMessages({
      ...cleaned,
      model: candidate.id,
    }, {
      sidecarCodec: scope.services.sidecarCodec.codecFor(SidecarDomain.TranslatedAssistantTurn),
      fallbackMaxOutputTokens: candidate.limits.max_output_tokens,
    });
    if (trip.type === 'input-error') {
      return {
        'response.http': { ...localResponseHead(400), body: null },
        'response.geminiGenerateContentCountTokens': {
          kind: 'error',
          source: 'local',
          error: geminiGenerateContentRpcErrorPayload(400, trip.message),
        },
      };
    }
    const { max_tokens: _maxTokens, stream: _stream, ...anthropic } = trip.target;
    const { 'response.anthropicMessagesCountTokens': outcome, ...answer } = await scope.into.anthropicMessages({
      ...request,
      'request.http': { ...http, headers: deleteHeader(http.headers, 'anthropic-beta') },
      'request.anthropicMessagesCountTokens': anthropic,
    });
    if (outcome.kind === 'error') {
      const head = answer['response.http'];
      const damaged = outcome.source === 'upstream' && head !== null && head.status >= 200 && head.status < 300;
      const status = damaged ? 502 : head?.status ?? (outcome.source === 'upstream' ? 502 : 499);
      return {
        ...answer,
        'response.geminiGenerateContentCountTokens': {
          kind: 'error',
          source: outcome.source,
          error: geminiGenerateContentRpcErrorPayload(status, JSON.stringify(outcome.error)),
        },
      };
    }
    const result = outcome.result === null ? null : { totalTokens: outcome.result.input_tokens };
    return {
      ...answer,
      'response.geminiGenerateContentCountTokens': { kind: 'result', result },
    };
  },
});
