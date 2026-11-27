import { chatBodyRequest, chatBodyResponse, chatEgressRequest, defineStage } from '../../pipeline/facts.ts';
import { translateChatAnswer } from '../../pipeline/translate-answer.ts';
import { SidecarDomain } from '../../shared/sidecar-codec.ts';
import { invalidOpenAIResponsesRequest } from '../errors.ts';
import { deleteHeader } from '@floway-dev/http';
import { routeOpenAIResponsesViaAnthropicMessages, routeOpenAIResponsesViaOpenAIChatCompletions } from '@floway-dev/translate';

export const routeOpenAIResponses = defineStage({
  name: 'openaiResponses.route',
  request: { needs: [...chatBodyRequest, 'openaiResponses'] },
  into: {
    native: {
      request: { needs: [...chatEgressRequest, 'openaiResponses'], provides: [], consumes: [] },
      response: { needs: [...chatBodyResponse, 'openaiResponses'], provides: [], consumes: [] },
    },
    anthropicMessages: {
      request: { needs: chatBodyRequest, provides: ['anthropicMessages', 'http'], consumes: ['openaiResponses'] },
      response: { needs: [...chatBodyResponse, 'anthropicMessages'], provides: ['http', 'openaiResponses'], consumes: ['anthropicMessages'] },
    },
    openaiChatCompletions: {
      request: { needs: chatBodyRequest, provides: ['openaiChatCompletions'], consumes: ['openaiResponses'] },
      response: { needs: [...chatBodyResponse, 'openaiChatCompletions'], provides: ['http', 'openaiResponses'], consumes: ['openaiChatCompletions'] },
    },
  },
  return: { provides: ['http', 'openaiResponses'] },
  async execute(facts, scope) {
    const target = facts['chat.target'];
    if (target === 'openaiResponses') return await scope.into.native(facts);
    const { openaiResponses, ...request } = facts;
    const payload = { ...openaiResponses, stream: true as const };
    const options = {
      sidecarCodec: scope.services.sidecarCodec.codecFor(SidecarDomain.TranslatedAssistantTurn),
      fallbackMaxOutputTokens: request.model.limits.max_output_tokens,
    };
    const context = { source: 'openaiResponses', target, dump: scope.services.dump } as const;
    switch (target) {
    case 'anthropicMessages': {
      const trip = await routeOpenAIResponsesViaAnthropicMessages(payload, options);
      if (trip.type === 'input-error') {
        const { http, outcome } = invalidOpenAIResponsesRequest(trip);
        return { http, openaiResponses: outcome };
      }
      const { anthropicMessages: outcome, ...answer } = await scope.into.anthropicMessages({
        ...request,
        anthropicMessages: trip.target,
        http: { ...request.http, headers: deleteHeader(request.http.headers, 'anthropic-beta') },
      });
      const mapped = translateChatAnswer(answer.http, outcome, trip, scope, context);
      return { ...answer, http: mapped.http, openaiResponses: mapped.outcome };
    }
    case 'openaiChatCompletions': {
      const trip = await routeOpenAIResponsesViaOpenAIChatCompletions(payload, options);
      if (trip.type === 'input-error') {
        const { http, outcome } = invalidOpenAIResponsesRequest(trip);
        return { http, openaiResponses: outcome };
      }
      const { openaiChatCompletions: outcome, ...answer } = await scope.into.openaiChatCompletions({
        ...request,
        openaiChatCompletions: trip.target,
      });
      const mapped = translateChatAnswer(answer.http, outcome, trip, scope, context);
      return { ...answer, http: mapped.http, openaiResponses: mapped.outcome };
    }
    default: throw new Error(`The openaiResponses body cannot enter ${target}`);
    }
  },
});
