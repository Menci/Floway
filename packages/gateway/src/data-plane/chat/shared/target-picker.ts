import type { CandidateRequest } from '../../pipeline/failover.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { ChatTargetApi } from '@floway-dev/provider';

export interface ChatTargetPicker {
  canServe: (endpoints: ModelEndpoints) => boolean;
  pick: (endpoints: ModelEndpoints) => ChatTargetApi;
}

export const chatTargetPicker = (preference: readonly ChatTargetApi[]): ChatTargetPicker => {
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

export interface TargetRequest extends CandidateRequest {
  readonly 'route.targetApi': ChatTargetApi;
}

export const pickTarget = (picker: ChatTargetPicker) => defineStage<CandidateRequest, TargetRequest, object, object>({
  name: 'pickTarget',
  through: {
    request: { needs: ['route.candidate'], consumes: [], provides: ['route.targetApi'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => await next({ ...facts, 'route.targetApi': picker.pick(facts['route.candidate'].endpoints) }),
});
