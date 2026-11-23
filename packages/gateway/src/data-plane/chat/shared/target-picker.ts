import type { CandidateRequest } from '../../pipeline/failover.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { ChatTargetApi } from '@floway-dev/provider';

export interface ChatTargetPicker<Api extends ChatTargetApi = ChatTargetApi> {
  canServe: (endpoints: ModelEndpoints) => boolean;
  pick: (endpoints: ModelEndpoints) => Api;
}

export const chatTargetPicker = <Api extends ChatTargetApi>(preference: readonly Api[]): ChatTargetPicker<Api> => {
  const find = (endpoints: ModelEndpoints) => preference.find(key => endpoints[key]);
  return {
    canServe: endpoints => find(endpoints) !== undefined,
    pick: endpoints => {
      const out = find(endpoints);
      if (out === undefined) throw new Error(`Chat candidate has none of the required endpoints: ${preference.join(', ')}`);
      return out;
    },
  };
};

export const openaiChatCompletionsTarget = chatTargetPicker(['openaiChatCompletions', 'anthropicMessages', 'openaiResponses']);
export const openaiResponsesTarget = chatTargetPicker(['openaiResponses', 'anthropicMessages', 'openaiChatCompletions']);
export const anthropicMessagesGenerateTarget = chatTargetPicker(['anthropicMessages', 'openaiResponses', 'openaiChatCompletions']);
export const anthropicMessagesCountTokensTarget = chatTargetPicker(['anthropicMessages']);
export const geminiGenerateContentGenerateTarget = chatTargetPicker(['geminiGenerateContent', 'openaiChatCompletions', 'anthropicMessages', 'openaiResponses']);
export const geminiGenerateContentCountTokensTarget = chatTargetPicker(['geminiGenerateContent', 'anthropicMessages']);

export interface TargetRequest<Api extends ChatTargetApi = ChatTargetApi> extends CandidateRequest {
  readonly 'route.targetApi': Api;
}

export const pickTarget = <Api extends ChatTargetApi>(picker: ChatTargetPicker<Api>) => defineStage<CandidateRequest, TargetRequest<Api>, object, object>({
  name: 'pickTarget',
  through: {
    request: { needs: ['route.candidate'], consumes: [], provides: ['route.targetApi'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => await next({ ...facts, 'route.targetApi': picker.pick(facts['route.candidate'].endpoints) }),
});
