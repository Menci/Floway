import type { CandidateRequest } from '../../pipeline/failover.ts';
import { providerSupportsOperation, type UpstreamFacts } from '../../providers/upstreams.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { ChatTargetApi, ProviderPipelines } from '@floway-dev/provider';

type UpstreamKind = UpstreamFacts['kind'];

export interface ChatTargetPicker<Api extends ChatTargetApi = ChatTargetApi> {
  canServe: (endpoints: ModelEndpoints, kind?: UpstreamKind) => boolean;
  pick: (endpoints: ModelEndpoints, kind?: UpstreamKind) => Api;
}

export const chatTargetPicker = <Api extends ChatTargetApi>(
  preference: readonly Api[], operation: (api: Api) => keyof ProviderPipelines = api => api,
): ChatTargetPicker<Api> => {
  const find = (endpoints: ModelEndpoints, kind?: UpstreamKind) =>
    preference.find(key => endpoints[key] && (kind === undefined || providerSupportsOperation(kind, operation(key))));
  return {
    canServe: (endpoints, kind) => find(endpoints, kind) !== undefined,
    pick: (endpoints, kind) => {
      const out = find(endpoints, kind);
      if (out === undefined) throw new Error(`Chat candidate has none of the required endpoints: ${preference.join(', ')}`);
      return out;
    },
  };
};

export const openaiChatCompletionsTarget = chatTargetPicker(['openaiChatCompletions', 'anthropicMessages', 'openaiResponses']);
export const openaiResponsesTarget = chatTargetPicker(['openaiResponses', 'anthropicMessages', 'openaiChatCompletions']);
export const anthropicMessagesGenerateTarget = chatTargetPicker(['anthropicMessages', 'openaiResponses', 'openaiChatCompletions']);
export const anthropicMessagesCountTokensTarget = chatTargetPicker(['anthropicMessages'], () => 'anthropicMessagesCountTokens');
export const geminiGenerateContentGenerateTarget = chatTargetPicker(['geminiGenerateContent', 'openaiChatCompletions', 'anthropicMessages', 'openaiResponses']);
export const geminiGenerateContentCountTokensTarget = chatTargetPicker(
  ['geminiGenerateContent', 'anthropicMessages'], api => api === 'geminiGenerateContent' ? 'geminiGenerateContentCountTokens' : 'anthropicMessagesCountTokens',
);

export interface TargetRequest<Api extends ChatTargetApi = ChatTargetApi> extends CandidateRequest {
  readonly 'route.targetApi': Api;
}

export const pickTarget = <Api extends ChatTargetApi>(picker: ChatTargetPicker<Api>) => defineStage<CandidateRequest, TargetRequest<Api>, object, object>({
  name: 'pickTarget',
  through: {
    request: { needs: ['route.candidate'], consumes: [], provides: ['route.targetApi'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, scope) => {
    const { endpoints, kind } = facts['route.candidate'];
    return await scope.next({ ...facts, 'route.targetApi': picker.pick(endpoints, kind) });
  },
});
