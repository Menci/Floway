import { chatBodyRequest, chatBodyResponse, chatEgressRequest, defineStage } from '../../pipeline/facts.ts';
import { translateChatAnswer } from '../../pipeline/translate-answer.ts';
import { SidecarDomain } from '../../shared/sidecar-codec.ts';
import { openaiChatCompletionsInputError } from '../errors.ts';
import { deleteHeader } from '@floway-dev/http';
import { routeOpenAIChatCompletionsViaAnthropicMessages, routeOpenAIChatCompletionsViaOpenAIResponses } from '@floway-dev/translate';

export const routeOpenAIChatCompletions = defineStage({
  name: 'openaiChatCompletions.route',
  request: { needs: [...chatBodyRequest, 'openaiChatCompletions'] },
  into: {
    native: {
      request: { needs: [...chatEgressRequest, 'openaiChatCompletions'], provides: [], consumes: [] },
      response: { needs: [...chatBodyResponse, 'openaiChatCompletions'], provides: [], consumes: [] },
    },
    anthropicMessages: {
      request: { needs: chatBodyRequest, provides: ['anthropicMessages', 'http'], consumes: ['openaiChatCompletions'] },
      response: { needs: [...chatBodyResponse, 'anthropicMessages'], provides: ['http', 'openaiChatCompletions'], consumes: ['anthropicMessages'] },
    },
    openaiResponses: {
      request: { needs: chatBodyRequest, provides: ['openaiResponses'], consumes: ['openaiChatCompletions'] },
      response: { needs: [...chatBodyResponse, 'openaiResponses'], provides: ['http', 'openaiChatCompletions'], consumes: ['openaiResponses'] },
    },
  },
  return: { provides: ['http', 'openaiChatCompletions'] },
  async execute(facts, scope) {
    const target = facts['chat.target'];
    if (target === 'openaiChatCompletions') return await scope.into.native(facts);
    const { openaiChatCompletions, ...request } = facts;
    const payload = { ...openaiChatCompletions, stream: true as const };
    const options = {
      sidecarCodec: scope.services.sidecarCodec.codecFor(SidecarDomain.TranslatedAssistantTurn),
      fallbackMaxOutputTokens: request.model.limits.max_output_tokens,
    };
    const context = { source: 'openaiChatCompletions', target, dump: scope.services.dump } as const;
    switch (target) {
    case 'anthropicMessages': {
      const trip = await routeOpenAIChatCompletionsViaAnthropicMessages(payload, options);
      if (trip.type === 'input-error') {
        const { http, outcome } = openaiChatCompletionsInputError(trip);
        return { http, openaiChatCompletions: outcome };
      }
      const { anthropicMessages: outcome, ...answer } = await scope.into.anthropicMessages({
        ...request,
        anthropicMessages: trip.target,
        http: { ...request.http, headers: deleteHeader(request.http.headers, 'anthropic-beta') },
      });
      const mapped = translateChatAnswer(answer.http, outcome, trip, scope, context);
      return { ...answer, http: mapped.http, openaiChatCompletions: mapped.outcome };
    }
    case 'openaiResponses': {
      const trip = await routeOpenAIChatCompletionsViaOpenAIResponses(payload, options);
      if (trip.type === 'input-error') {
        const { http, outcome } = openaiChatCompletionsInputError(trip);
        return { http, openaiChatCompletions: outcome };
      }
      const { openaiResponses: outcome, ...answer } = await scope.into.openaiResponses({
        ...request,
        openaiResponses: trip.target,
      });
      const mapped = translateChatAnswer(answer.http, outcome, trip, scope, context);
      return { ...answer, http: mapped.http, openaiChatCompletions: mapped.outcome };
    }
    default: throw new Error(`The openaiChatCompletions body cannot enter ${target}`);
    }
  },
});
