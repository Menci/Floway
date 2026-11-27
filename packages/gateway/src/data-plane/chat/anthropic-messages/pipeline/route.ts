import { chatBodyRequest, chatBodyResponse, chatEgressRequest, defineStage } from '../../pipeline/facts.ts';
import { translateChatAnswer } from '../../pipeline/translate-answer.ts';
import { SidecarDomain } from '../../shared/sidecar-codec.ts';
import { anthropicMessagesInputError } from '../errors.ts';
import { routeAnthropicMessagesViaOpenAIResponses, routeAnthropicMessagesViaOpenAIChatCompletions } from '@floway-dev/translate';

export const routeAnthropicMessages = defineStage({
  name: 'anthropicMessages.route',
  request: { needs: [...chatBodyRequest, 'anthropicMessages'] },
  into: {
    native: {
      request: { needs: [...chatEgressRequest, 'anthropicMessages'], provides: [], consumes: [] },
      response: { needs: [...chatBodyResponse, 'anthropicMessages'], provides: [], consumes: [] },
    },
    openaiResponses: {
      request: { needs: chatBodyRequest, provides: ['openaiResponses'], consumes: ['anthropicMessages'] },
      response: { needs: [...chatBodyResponse, 'openaiResponses'], provides: ['http', 'anthropicMessages'], consumes: ['openaiResponses'] },
    },
    openaiChatCompletions: {
      request: { needs: chatBodyRequest, provides: ['openaiChatCompletions'], consumes: ['anthropicMessages'] },
      response: { needs: [...chatBodyResponse, 'openaiChatCompletions'], provides: ['http', 'anthropicMessages'], consumes: ['openaiChatCompletions'] },
    },
  },
  return: { provides: ['http', 'anthropicMessages'] },
  async execute(facts, scope) {
    const target = facts['chat.target'];
    if (target === 'anthropicMessages') return await scope.into.native(facts);
    const { anthropicMessages, ...request } = facts;
    const payload = { ...anthropicMessages, stream: true as const };
    const options = {
      sidecarCodec: scope.services.sidecarCodec.codecFor(SidecarDomain.TranslatedAssistantTurn),
      fallbackMaxOutputTokens: request.model.limits.max_output_tokens,
    };
    const context = { source: 'anthropicMessages', target, dump: scope.services.dump } as const;
    switch (target) {
    case 'openaiResponses': {
      const trip = await routeAnthropicMessagesViaOpenAIResponses(payload, options);
      if (trip.type === 'input-error') {
        const { http, outcome } = anthropicMessagesInputError(trip);
        return { http, anthropicMessages: outcome };
      }
      const { openaiResponses: outcome, ...answer } = await scope.into.openaiResponses({
        ...request,
        openaiResponses: trip.target,
      });
      const mapped = translateChatAnswer(answer.http, outcome, trip, scope, context);
      return { ...answer, http: mapped.http, anthropicMessages: mapped.outcome };
    }
    case 'openaiChatCompletions': {
      const trip = await routeAnthropicMessagesViaOpenAIChatCompletions(payload, options);
      if (trip.type === 'input-error') {
        const { http, outcome } = anthropicMessagesInputError(trip);
        return { http, anthropicMessages: outcome };
      }
      const { openaiChatCompletions: outcome, ...answer } = await scope.into.openaiChatCompletions({
        ...request,
        openaiChatCompletions: trip.target,
      });
      const mapped = translateChatAnswer(answer.http, outcome, trip, scope, context);
      return { ...answer, http: mapped.http, anthropicMessages: mapped.outcome };
    }
    default: throw new Error(`The anthropicMessages body cannot enter ${target}`);
    }
  },
});
