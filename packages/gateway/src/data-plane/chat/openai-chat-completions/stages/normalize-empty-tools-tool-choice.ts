import type { ChatAttemptOutcome, ChatPipelineServices, OpenAIChatCompletionsAttemptInput } from '../../pipeline/index.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { hasEnabledFlag, type ChatTargetApi } from '@floway-dev/provider';

interface Facts extends OpenAIChatCompletionsAttemptInput {
  readonly 'route.targetApi': ChatTargetApi;
}

// Opt-in compatibility rewrite for upstreams that reject an active tool choice
// when the caller explicitly supplies no tools.
export const normalizeEmptyToolsToolChoice = defineStage<
  Facts,
  Pick<Facts, 'request.payload'>,
  ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
  ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
  never,
  ChatPipelineServices
>({
  name: 'normalizeEmptyToolsToolChoice',
  provides: ['request.payload'],
  execute: async (facts, next) => {
    const payload = facts['request.payload'];
    if (!hasEnabledFlag(facts['route.candidate'].providerModel, 'empty-tools-tool-choice-none')
      || !Array.isArray(payload.tools)
      || payload.tools.length !== 0) {
      return await next({ 'request.payload': facts['request.payload'] });
    }
    return await next({ 'request.payload': { ...payload, tool_choice: 'none' } });
  },
});
