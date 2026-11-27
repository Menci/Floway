import { chatBodyRequest, chatBodyResponse, chatEgressRequest, defineStage } from '../../pipeline/facts.ts';
import { translateChatAnswer } from '../../pipeline/translate-answer.ts';
import { SidecarDomain } from '../../shared/sidecar-codec.ts';
import { geminiGenerateContentInputError } from '../errors.ts';
import { deleteHeader } from '@floway-dev/http';
import { routeGeminiGenerateContentViaOpenAIChatCompletions, routeGeminiGenerateContentViaAnthropicMessages, routeGeminiGenerateContentViaOpenAIResponses } from '@floway-dev/translate';

export const routeGeminiGenerateContent = defineStage({
  name: 'geminiGenerateContent.route',
  request: { needs: [...chatBodyRequest, 'geminiGenerateContent'] },
  into: {
    native: {
      request: { needs: [...chatEgressRequest, 'geminiGenerateContent'], provides: [], consumes: [] },
      response: { needs: [...chatBodyResponse, 'geminiGenerateContent'], provides: [], consumes: [] },
    },
    openaiChatCompletions: {
      request: { needs: chatBodyRequest, provides: ['openaiChatCompletions'], consumes: ['geminiGenerateContent'] },
      response: { needs: [...chatBodyResponse, 'openaiChatCompletions'], provides: ['http', 'geminiGenerateContent'], consumes: ['openaiChatCompletions'] },
    },
    anthropicMessages: {
      request: { needs: chatBodyRequest, provides: ['anthropicMessages', 'http'], consumes: ['geminiGenerateContent'] },
      response: { needs: [...chatBodyResponse, 'anthropicMessages'], provides: ['http', 'geminiGenerateContent'], consumes: ['anthropicMessages'] },
    },
    openaiResponses: {
      request: { needs: chatBodyRequest, provides: ['openaiResponses'], consumes: ['geminiGenerateContent'] },
      response: { needs: [...chatBodyResponse, 'openaiResponses'], provides: ['http', 'geminiGenerateContent'], consumes: ['openaiResponses'] },
    },
  },
  return: { provides: ['http', 'geminiGenerateContent'] },
  async execute(facts, scope) {
    const target = facts['chat.target'];
    if (target === 'geminiGenerateContent') return await scope.into.native(facts);
    const { geminiGenerateContent, ...request } = facts;
    const payload = { ...geminiGenerateContent, model: request.requestedModel, stream: true as const };
    const options = {
      sidecarCodec: scope.services.sidecarCodec.codecFor(SidecarDomain.TranslatedAssistantTurn),
      fallbackMaxOutputTokens: request.model.limits.max_output_tokens,
    };
    const context = { source: 'geminiGenerateContent', target, dump: scope.services.dump } as const;
    switch (target) {
    case 'openaiChatCompletions': {
      const trip = await routeGeminiGenerateContentViaOpenAIChatCompletions(payload, options);
      if (trip.type === 'input-error') {
        const { http, outcome } = geminiGenerateContentInputError(trip);
        return { http, geminiGenerateContent: outcome };
      }
      const { openaiChatCompletions: outcome, ...answer } = await scope.into.openaiChatCompletions({
        ...request,
        openaiChatCompletions: trip.target,
      });
      const mapped = translateChatAnswer(answer.http, outcome, trip, scope, context);
      return { ...answer, http: mapped.http, geminiGenerateContent: mapped.outcome };
    }
    case 'anthropicMessages': {
      const trip = await routeGeminiGenerateContentViaAnthropicMessages(payload, options);
      if (trip.type === 'input-error') {
        const { http, outcome } = geminiGenerateContentInputError(trip);
        return { http, geminiGenerateContent: outcome };
      }
      const { anthropicMessages: outcome, ...answer } = await scope.into.anthropicMessages({
        ...request,
        anthropicMessages: trip.target,
        http: { ...request.http, headers: deleteHeader(request.http.headers, 'anthropic-beta') },
      });
      const mapped = translateChatAnswer(answer.http, outcome, trip, scope, context);
      return { ...answer, http: mapped.http, geminiGenerateContent: mapped.outcome };
    }
    case 'openaiResponses': {
      const trip = await routeGeminiGenerateContentViaOpenAIResponses(payload, options);
      if (trip.type === 'input-error') {
        const { http, outcome } = geminiGenerateContentInputError(trip);
        return { http, geminiGenerateContent: outcome };
      }
      const { openaiResponses: outcome, ...answer } = await scope.into.openaiResponses({
        ...request,
        openaiResponses: trip.target,
      });
      const mapped = translateChatAnswer(answer.http, outcome, trip, scope, context);
      return { ...answer, http: mapped.http, geminiGenerateContent: mapped.outcome };
    }
    default: throw new Error(`The geminiGenerateContent body cannot enter ${target}`);
    }
  },
});
