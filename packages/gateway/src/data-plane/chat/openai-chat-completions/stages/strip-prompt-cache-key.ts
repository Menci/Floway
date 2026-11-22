import type { ChatAttemptOutcome, ChatPipelineServices, OpenAIChatCompletionsAttemptInput } from '../../pipeline/index.ts';
import { defineStage } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { hasEnabledFlag, type ChatTargetApi } from '@floway-dev/provider';

interface Facts extends OpenAIChatCompletionsAttemptInput {
  readonly 'route.targetApi': ChatTargetApi;
}

// Opt-in workaround for upstreams that reject `prompt_cache_key` as an unknown
// request argument.
export const stripPromptCacheKey = defineStage<
  Facts,
  Pick<Facts, 'request.payload'>,
  ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
  ChatAttemptOutcome<OpenAIChatCompletionsStreamEvent>,
  never,
  ChatPipelineServices
>({
  name: 'stripPromptCacheKey',
  provides: ['request.payload'],
  execute: async (facts, next) => {
    const payload = facts['request.payload'];
    if (!hasEnabledFlag(facts['route.candidate'].providerModel, 'strip-prompt-cache-key')
      || payload.prompt_cache_key === undefined) {
      return await next({ 'request.payload': facts['request.payload'] });
    }
    const { prompt_cache_key: _stripped, ...rest } = payload;
    return await next({ 'request.payload': rest });
  },
});
