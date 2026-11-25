import { defineStage } from '../../../pipeline/facts.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';
import type { FlagId } from '@floway-dev/provider';

export const openAIChatCompletionsPayloadStage = (
  name: string,
  shape: (payload: OpenAIChatCompletionsPayloadEx, flags: readonly FlagId[]) => OpenAIChatCompletionsPayloadEx,
) => defineStage({
  name: `openaiChatCompletions.${name}`,
  through: {
    request: { needs: ['request.openaiChatCompletions', 'provider.model'], provides: ['request.openaiChatCompletions'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: async (facts, scope) => await scope.next({
    ...facts,
    'request.openaiChatCompletions': shape(facts['request.openaiChatCompletions'], facts['provider.model'].enabledFlags),
  }),
});
